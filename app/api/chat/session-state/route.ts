import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * Single source of truth for the client's poll-while-thinking loop.
 *
 * Replaces the old Supabase Realtime pipeline (postgres_changes on
 * `chat_messages` + `chat_sessions` + a 3-timer REST fallback) with a
 * dumb, deterministic HTTP endpoint the client hits on a fixed cadence
 * while a chat turn is in flight.
 *
 * Why combined (status + new messages) in one response:
 *   - Atomic snapshot: either we see `status='thinking'` with whatever
 *     assistant rows have landed so far, or `status='idle'` with ALL
 *     the rows, in the same response. No "did idle arrive before the
 *     last message?" reconciliation logic needed on the client.
 *   - One round-trip per tick instead of two.
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
 */
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

    const sessionPromise = supabase
      .from('chat_sessions')
      .select('status, status_updated_at')
      .eq('id', sessionId)
      .maybeSingle()

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

    const [sessionResult, messagesResult, proposalsResult] = await Promise.all([
      sessionPromise,
      messagesQuery,
      proposalsQuery,
    ])

    if (sessionResult.error) {
      chatServerLog('error', 'session_state_session_fetch_failed', {
        err: sessionResult.error,
        sessionId,
        userId: user.id,
      })
      return NextResponse.json(
        { error: 'Failed to load session' },
        { status: 500 },
      )
    }

    if (!sessionResult.data) {
      // Either the session truly doesn't exist or RLS filtered it out.
      // Collapse to 404 — the client can't distinguish and shouldn't.
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

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

    const messageRows = messagesResult.data ?? []
    const proposalRows = proposalsResult.data ?? []

    // Union by id so `flow_proposals` rows that already fell within the
    // `since` window aren't duplicated in the response.
    const seen = new Set(messageRows.map((m) => m.id))
    const merged = [...messageRows]
    for (const row of proposalRows) {
      if (!seen.has(row.id)) merged.push(row)
    }

    return NextResponse.json({
      status: sessionResult.data.status ?? 'idle',
      statusUpdatedAt: sessionResult.data.status_updated_at ?? null,
      newMessages: merged,
    })
  } catch (err) {
    chatServerLog('error', 'session_state_unhandled', { err })
    return NextResponse.json(
      { error: 'Failed to load session state' },
      { status: 500 },
    )
  }
}
