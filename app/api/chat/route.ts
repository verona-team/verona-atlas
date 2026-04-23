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
 * How long we treat an existing `active_chat_call_id` as "still in flight".
 * Must be <= the Modal function's timeout (currently 3600s) so we never
 * hold the UI hostage behind a dead call.
 */
const ACTIVE_CALL_MAX_AGE_MS = 60 * 60 * 1000

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

    // -------- Duplicate-turn / already-in-flight guard --------
    // Check BEFORE persisting the user message so that a genuinely new
    // message (different client_message_id) is never written to the DB if
    // we're going to reject the spawn anyway. Writing an orphaned row here
    // would leave a message the running Modal worker doesn't know about and
    // that no new worker will be spawned to process.
    const { data: existingSession } = await service
      .from('chat_sessions')
      .select('active_chat_call_id, active_chat_call_started_at')
      .eq('id', session.id)
      .single()

    const existingCallId = existingSession?.active_chat_call_id ?? null
    const existingStartedAt = existingSession?.active_chat_call_started_at
      ? new Date(existingSession.active_chat_call_started_at).getTime()
      : null
    const existingCallIsAlive =
      !!existingCallId &&
      !!existingStartedAt &&
      Date.now() - existingStartedAt < ACTIVE_CALL_MAX_AGE_MS

    if (existingCallIsAlive) {
      chatServerLog('info', 'chat_duplicate_spawn_short_circuit', {
        projectId,
        sessionId: session.id,
        userId: user.id,
        existingCallId,
      })
      return NextResponse.json(
        { ok: true, functionCallId: existingCallId, reused: true },
        { status: 202 },
      )
    }

    // Upsert the user message row. The unique constraint on
    // (session_id, client_message_id) makes this a no-op if the client
    // hard-refreshed and re-fired with the same id, so no duplicate is
    // written. The Python worker relies on finding this row when it starts.
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

    // -------- Mark session thinking + spawn Modal --------
    // We set status BEFORE spawning so the client's Realtime subscription
    // flips to the thinking indicator right away. If the spawn fails we
    // reset it below.
    await service
      .from('chat_sessions')
      .update({
        status: 'thinking',
        status_updated_at: new Date().toISOString(),
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

    // Persist the call id + timestamp so subsequent POSTs can see
    // "already in flight" and short-circuit.
    await service
      .from('chat_sessions')
      .update({
        active_chat_call_id: functionCallId,
        active_chat_call_started_at: new Date().toISOString(),
      })
      .eq('id', session.id)

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
