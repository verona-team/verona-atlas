import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * Single source of truth for the client's poll-while-busy loop.
 *
 * Replaces the old Supabase Realtime pipeline (postgres_changes on
 * `chat_messages` + `chat_sessions` + a 3-timer REST fallback) with a
 * dumb, deterministic HTTP endpoint the client hits on a fixed cadence
 * while ANY backend work is in flight for this session — either a
 * LangGraph chat turn (`chat_sessions.status='thinking'`) OR a test run
 * spawned from chat (`test_runs.status IN ('pending','planning','running')`
 * for a row with `trigger='chat'` on the session's project). Both are
 * returned in one response so the client has a single "is the backend
 * busy for this session" signal to drive the input-disabled gate and
 * keep polling alive — critical for the `live_session` chat bubble
 * (inserted by `runner/execute.py` while a test template runs) to reach
 * the UI in realtime, since the chat-turn finalize fires BEFORE
 * `execute_test_run` actually starts the browser.
 *
 * Why combined (status + new messages + active run) in one response:
 *   - Atomic snapshot: either we see `status='thinking'` / an active
 *     test_run with whatever assistant rows have landed so far, or the
 *     idle terminal state with ALL the rows, in the same response. No
 *     "did idle arrive before the last message?" reconciliation logic
 *     needed on the client.
 *   - One round-trip per tick instead of three.
 *
 * Auth: user-cookie Supabase client (NOT service role). RLS on
 * `chat_messages` + `chat_sessions` (migration 013) already scopes
 * results to the caller's org, so an unauthorized request gets either
 * 401 (no user) or 404 (session not visible / doesn't exist, indistinguishable
 * to the caller which is what we want).
 *
 * Cursor: `since` is an ISO timestamp; we return rows with
 * `created_at > since` (strict gt). `chat_messages.created_at` is
 * microsecond-precision TIMESTAMPTZ and never collides across the two
 * writers (Next.js route + Python Modal worker — never concurrent on
 * the same session), so gt avoids re-delivering the cursor row on
 * every tick without risking a missed row.
 *
 * Flow-proposal re-delivery: `flow_proposals` rows also mutate in place
 * (the Python worker flips an existing row's `metadata.status` to
 * 'superseded' when a new proposals row is generated — see
 * `runner/chat/nodes.py`). `chat_messages` has no `updated_at` column,
 * so a pure `created_at` cursor can't detect those UPDATEs. We work
 * around this by always returning the session's `flow_proposals` rows
 * (typically 1-3 per session) regardless of cursor, merged into the
 * same `newMessages` array. The client's id-keyed merge dedupes against
 * its existing state, so the steady-state cost is near zero while the
 * correctness guarantee is absolute: any status/flow_states mutation
 * on a proposals row is observed within one poll tick.
 *
 * Live-session re-delivery: `live_session` rows ALSO mutate in place —
 * when a test template finishes, `runner/execute.py` rewrites
 * `metadata.status` from 'running' to 'passed'/'failed'/'error' and
 * adds `recording_url`. Same trick as flow_proposals: always re-fetch
 * the session's `live_session` rows regardless of cursor. Bounded at 20
 * rows (well above any realistic single-run template count).
 */

/**
 * Upper bound on "active test run" liveness. Mirrors `THINKING_MAX_AGE_MS`
 * in `app/api/chat/route.ts`. A Modal test-run function can legitimately
 * run for up to `SECONDS_PER_TEMPLATE * len(templates)` (1 hour per
 * template in `runner/execute.py`); 4 hours is comfortably above realistic
 * runs but stops a hung/crashed worker from holding the UI hostage forever.
 */
const ACTIVE_TEST_RUN_MAX_AGE_MS = 4 * 60 * 60 * 1000
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const user = await getServerUser(supabase)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId is required' },
        { status: 400 },
      )
    }

    const sinceParam = request.nextUrl.searchParams.get('since')
    let since: string | null = null
    if (sinceParam !== null && sinceParam !== '') {
      const parsed = new Date(sinceParam)
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: 'since must be a valid ISO timestamp' },
          { status: 400 },
        )
      }
      since = parsed.toISOString()
    }

    // Fetch the session row first so we can use its `project_id` to
    // locate active test runs. The remaining queries then fan out in
    // parallel. Adds ~one extra hop vs. pure parallelism, but the
    // session select is tiny and the client's 2.5s cadence easily
    // absorbs it.
    const { data: sessionData, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('status, status_updated_at, project_id')
      .eq('id', sessionId)
      .maybeSingle()

    if (sessionError) {
      chatServerLog('error', 'session_state_session_fetch_failed', {
        err: sessionError,
        sessionId,
        userId: user.id,
      })
      return NextResponse.json(
        { error: 'Failed to load session' },
        { status: 500 },
      )
    }

    if (!sessionData) {
      // Either the session truly doesn't exist or RLS filtered it out.
      // Collapse to 404 — the client can't distinguish and shouldn't.
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const projectId = sessionData.project_id

    // Cap at 200 to bound misbehaving clients (e.g. a stale cursor from
    // long ago). Normal steady-state tick returns 0-2 rows.
    let messagesQuery = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200)

    if (since) {
      messagesQuery = messagesQuery.gt('created_at', since)
    }

    // Always re-fetch flow_proposals rows — their metadata mutates
    // in place (superseded transitions, PATCH /api/chat/flows updates)
    // and a created_at cursor alone can't see those. Tiny payload (~1-3
    // rows per session); client dedupes by id.
    const proposalsQuery = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('metadata->>type', 'flow_proposals')
      .order('created_at', { ascending: true })
      .limit(20)

    // Same trick for live_session rows — their metadata flips from
    // 'running' to a terminal state (`passed`/`failed`/`error`) when
    // `execute_single_template` finishes, and we need the UI to flip
    // the iframe off and the recording link on in the same poll cycle.
    const liveSessionsQuery = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .eq('metadata->>type', 'live_session')
      .order('created_at', { ascending: true })
      .limit(20)

    // Active chat-triggered test run on this session's project. There
    // is at most one `chat_sessions` row per project (unique constraint),
    // so "active run for this session" === "active chat-triggered run
    // for this project". Filter by trigger='chat' so scheduled/nightly
    // runs never keep the chat input disabled.
    const activeRunQuery = supabase
      .from('test_runs')
      .select('id, status, created_at, started_at')
      .eq('project_id', projectId)
      .eq('trigger', 'chat')
      .in('status', ['pending', 'planning', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const [messagesResult, proposalsResult, liveSessionsResult, activeRunResult] =
      await Promise.all([
        messagesQuery,
        proposalsQuery,
        liveSessionsQuery,
        activeRunQuery,
      ])

    if (messagesResult.error) {
      chatServerLog('error', 'session_state_messages_fetch_failed', {
        err: messagesResult.error,
        sessionId,
        userId: user.id,
      })
      return NextResponse.json(
        { error: 'Failed to load messages' },
        { status: 500 },
      )
    }

    if (proposalsResult.error) {
      chatServerLog('error', 'session_state_proposals_fetch_failed', {
        err: proposalsResult.error,
        sessionId,
        userId: user.id,
      })
      // Soft-fail: return whatever we have. The client id-dedupes, so
      // the worst consequence of missing proposals rows on this tick
      // is that a supersede transition is observed one tick later.
    }

    if (liveSessionsResult.error) {
      chatServerLog('error', 'session_state_live_sessions_fetch_failed', {
        err: liveSessionsResult.error,
        sessionId,
        userId: user.id,
      })
      // Soft-fail: same reasoning as proposals.
    }

    if (activeRunResult.error) {
      chatServerLog('error', 'session_state_active_run_fetch_failed', {
        err: activeRunResult.error,
        sessionId,
        projectId,
        userId: user.id,
      })
      // Soft-fail: treat as "no active run" rather than 500ing the whole
      // tick. Worst case the chat input un-disables for a moment and
      // the next tick re-disables it. Don't block the messages payload
      // on this.
    }

    const messageRows = messagesResult.data ?? []
    const proposalRows = proposalsResult.data ?? []
    const liveSessionRows = liveSessionsResult.data ?? []

    // Union by id so rows that already fell within the `since` window
    // aren't duplicated in the response.
    const seen = new Set(messageRows.map((m) => m.id))
    const merged = [...messageRows]
    for (const row of proposalRows) {
      if (!seen.has(row.id)) {
        merged.push(row)
        seen.add(row.id)
      }
    }
    for (const row of liveSessionRows) {
      if (!seen.has(row.id)) {
        merged.push(row)
        seen.add(row.id)
      }
    }

    // Safety cap on the active-run signal. If a worker crashed badly
    // enough to leave a test_runs row stuck in 'pending'/'planning'/
    // 'running' forever, we do NOT want the chat input permanently
    // disabled. The 4h window is well above any realistic run.
    const activeRunRow = activeRunResult.data ?? null
    let activeTestRun: {
      id: string
      status: string
      createdAt: string
    } | null = null
    if (activeRunRow) {
      const ageMs =
        Date.now() - new Date(activeRunRow.created_at).getTime()
      if (ageMs < ACTIVE_TEST_RUN_MAX_AGE_MS) {
        activeTestRun = {
          id: activeRunRow.id,
          status: activeRunRow.status,
          createdAt: activeRunRow.created_at,
        }
      }
    }

    return NextResponse.json({
      status: sessionData.status ?? 'idle',
      statusUpdatedAt: sessionData.status_updated_at ?? null,
      newMessages: merged,
      activeTestRun,
    })
  } catch (err) {
    chatServerLog('error', 'session_state_unhandled', { err })
    return NextResponse.json(
      { error: 'Failed to load session state' },
      { status: 500 },
    )
  }
}
