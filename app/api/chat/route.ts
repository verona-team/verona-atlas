import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getOrCreateSession } from '@/lib/chat/session'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'
import { chatServerLog } from '@/lib/chat/server-log'
import { triggerChatTurn } from '@/lib/modal'

/**
 * This route used to run the entire chat turn — research agent, LLM,
 * tool execution, DB writes — inside the Vercel serverless function. That
 * scheme died on hard refresh / tab close because Vercel's runtime tore
 * down fire-and-forget drains as soon as the response was cancelled,
 * leaving turns stuck after the preamble streamed.
 *
 * New shape: this route does auth + membership + GitHub guard, persists the
 * user message, hands off to Modal (`process_chat_turn`), and returns 202.
 * The Python worker writes the assistant reply into `chat_messages` and the
 * client renders from Supabase Realtime. Browser disconnect is now
 * completely unrelated to turn completion.
 *
 * Contracts with the client:
 *
 *   - Body: { projectId: string, message: { id: string, text: string } }
 *     `message.id` is the UIMessage id the client assigned; we upsert into
 *     `chat_messages` with that as `client_message_id` for idempotent
 *     rendering + dedup.
 *
 *   - Response codes:
 *     - 202: spawn succeeded (or was a legitimate duplicate we short-circuited).
 *     - 400 GITHUB_SETUP_REQUIRED: unchanged behavior; client opens settings.
 *     - 401/404/500: standard.
 */

// Spawn + DB round-trips typically complete in well under 5s.
export const maxDuration = 30

type UIMessagePart = { type: 'text'; text?: string }
type IncomingMessage = { id: string; parts?: UIMessagePart[]; text?: string }

type IncomingBody = {
  projectId?: string
  message?: IncomingMessage
}

function extractMessageText(msg: IncomingMessage): string {
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('')
  }
  return ''
}

/**
 * How long we treat a session whose `status='thinking'` as still actually
 * running. Must be <= the Modal function's timeout (currently 3600s) so we
 * never hold the UI hostage behind a dead worker that never cleaned up
 * its own status.
 *
 * We use `status` (not `active_chat_call_id`) as the source of truth for
 * "is a turn in flight." The call id is prone to a write-after-finalize
 * race: the API route writes it AFTER spawn returns, but a fast Modal
 * worker can finalize (and null the id) in between. Reserving
 * active_chat_call_id as purely observational avoids that race.
 */
const THINKING_MAX_AGE_MS = 60 * 60 * 1000

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  let body: IncomingBody
  try {
    body = (await request.json()) as IncomingBody
  } catch (err) {
    chatServerLog('error', 'chat_post_invalid_json', { err, userId: user.id })
    return new Response('Invalid JSON body', { status: 400 })
  }

  const { projectId, message } = body
  if (!projectId) {
    return new Response('projectId is required', { status: 400 })
  }
  if (!message || typeof message.id !== 'string') {
    return new Response('message.id is required', { status: 400 })
  }

  const text = extractMessageText(message)
  if (!text.trim()) {
    return new Response('message has no text content', { status: 400 })
  }

  try {
    // -------- Membership + project ownership --------
    const { data: membership } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()

    if (!membership) {
      return new Response('No organization found', { status: 404 })
    }

    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('org_id', membership.org_id)
      .single()

    if (!project) {
      return new Response('Project not found', { status: 404 })
    }

    // -------- GitHub-ready guard (same structured error code as before) --------
    const gh = await getGithubIntegrationReady(supabase, projectId)
    if (!gh.ok) {
      return NextResponse.json(
        { error: gh.reason, code: 'GITHUB_SETUP_REQUIRED' },
        { status: 400 },
      )
    }

    // -------- Service-role client for writes + Modal spawn --------
    const service = createServiceRoleClient()
    const session = await getOrCreateSession(service, projectId)

    // -------- Load current session state for the dedup guard --------
    // We use `status == 'thinking'` as the source of truth for "a turn is
    // currently in flight." See the THINKING_MAX_AGE_MS doc for why this
    // beats gating on active_chat_call_id (which is susceptible to a
    // write-after-finalize race).
    const { data: existingSession } = await service
      .from('chat_sessions')
      .select('status, status_updated_at, active_chat_call_id')
      .eq('id', session.id)
      .single()

    const statusUpdatedAtMs = existingSession?.status_updated_at
      ? new Date(existingSession.status_updated_at).getTime()
      : null
    const turnInFlight =
      existingSession?.status === 'thinking' &&
      !!statusUpdatedAtMs &&
      Date.now() - statusUpdatedAtMs < THINKING_MAX_AGE_MS

    if (turnInFlight) {
      // Two sub-cases:
      //
      //   (a) Same client_message_id as the one the in-flight worker is
      //       already processing. This is the hard-refresh / bootstrap re-fire
      //       pattern — the row the worker needs already exists (it was
      //       upserted by the ORIGINAL POST that spawned the worker). Short-
      //       circuit with 202 reused:true so the client doesn't retry and
      //       the re-fire is a genuine no-op.
      //
      //   (b) Different client_message_id — the user typed a follow-up while
      //       the previous turn is still running. We MUST NOT silently 202
      //       with a stale call id (the message would never be processed and
      //       the client's optimistic bubble would be a ghost). Instead return
      //       409 TURN_IN_FLIGHT so the client knows to drop the bubble and
      //       prompt the user to wait.
      const { data: existingUserMsg } = await service
        .from('chat_messages')
        .select('id')
        .eq('session_id', session.id)
        .eq('client_message_id', message.id)
        .maybeSingle()

      if (existingUserMsg) {
        chatServerLog('info', 'chat_duplicate_spawn_short_circuit', {
          projectId,
          sessionId: session.id,
          userId: user.id,
          clientMessageId: message.id,
          existingCallId: existingSession?.active_chat_call_id ?? null,
        })
        return NextResponse.json(
          {
            ok: true,
            functionCallId: existingSession?.active_chat_call_id ?? null,
            reused: true,
          },
          { status: 202 },
        )
      }

      chatServerLog('info', 'chat_turn_in_flight_rejected', {
        projectId,
        sessionId: session.id,
        userId: user.id,
        clientMessageId: message.id,
      })
      return NextResponse.json(
        {
          error:
            'Verona is still working on your previous message. Please wait for it to finish before sending another.',
          code: 'TURN_IN_FLIGHT',
        },
        { status: 409 },
      )
    }

    // -------- Persist the user message row --------
    // Unique constraint on (session_id, client_message_id) makes this a
    // no-op if the client hard-refreshed and re-fired with the same id.
    // The Python worker relies on finding this row at startup.
    const { error: userMsgErr } = await service
      .from('chat_messages')
      .upsert(
        {
          session_id: session.id,
          role: 'user',
          content: text,
          client_message_id: message.id,
        },
        {
          onConflict: 'session_id,client_message_id',
          ignoreDuplicates: true,
        },
      )
    if (userMsgErr) {
      chatServerLog('warn', 'chat_user_message_persist_failed', {
        err: userMsgErr,
        projectId,
        sessionId: session.id,
        userId: user.id,
      })
    }

    // -------- Mark session thinking + clear any stale call id --------
    // Clearing active_chat_call_id here guarantees we start from a clean
    // slate for this turn. The field is observational (useful for cancel
    // and debugging); the CAS-style write after spawn below leaves it as
    // the id of the currently-running worker when possible, but we no
    // longer depend on it for liveness.
    const statusUpdatedAt = new Date().toISOString()
    await service
      .from('chat_sessions')
      .update({
        status: 'thinking',
        status_updated_at: statusUpdatedAt,
        active_chat_call_id: null,
        active_chat_call_started_at: null,
      })
      .eq('id', session.id)

    let functionCallId: string
    try {
      functionCallId = await triggerChatTurn(session.id, projectId, message.id)
    } catch (spawnErr) {
      chatServerLog('error', 'chat_modal_spawn_failed', {
        err: spawnErr,
        projectId,
        sessionId: session.id,
        userId: user.id,
      })
      // Reset session so the UI doesn't get stuck on "thinking".
      await service
        .from('chat_sessions')
        .update({
          status: 'error',
          status_updated_at: new Date().toISOString(),
          active_chat_call_id: null,
          active_chat_call_started_at: null,
        })
        .eq('id', session.id)
      return NextResponse.json(
        { error: 'Failed to schedule chat turn. Please try again.' },
        { status: 500 },
      )
    }

    // Best-effort record of the new call id. We intentionally gate on
    // `active_chat_call_id IS NULL` so that if the Modal worker finalized
    // between our spawn-return and this write, we don't clobber the
    // null-that-finalize wrote with the id of a now-dead call. This is
    // observational, not liveness — see THINKING_MAX_AGE_MS.
    await service
      .from('chat_sessions')
      .update({
        active_chat_call_id: functionCallId,
        active_chat_call_started_at: new Date().toISOString(),
      })
      .eq('id', session.id)
      .is('active_chat_call_id', null)

    chatServerLog('info', 'chat_modal_turn_spawned', {
      projectId,
      sessionId: session.id,
      userId: user.id,
      functionCallId,
      clientMessageId: message.id,
    })

    return NextResponse.json(
      { ok: true, functionCallId, reused: false },
      { status: 202 },
    )
  } catch (err) {
    chatServerLog('error', 'chat_post_unhandled_exception', {
      err,
      projectId,
      userId: user.id,
    })
    return NextResponse.json(
      { error: 'Chat request failed. Please try again.' },
      { status: 500 },
    )
  }
}
