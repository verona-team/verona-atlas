'use client'

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type SyntheticEvent,
} from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { ArrowUp, ArrowDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { MessageBubble } from './message-bubble'
import { ThinkingIndicator } from './thinking-indicator'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { Json, ChatMessage } from '@/lib/supabase/types'
import { cn } from '@/lib/utils'
import { useGithubReady } from '@/lib/settings-prefetch'

const STALE_THINKING_MS = 15 * 60 * 1000
const NEAR_BOTTOM_THRESHOLD_PX = 96

/**
 * The user-facing text for the auto-bootstrap turn. Still used as both
 * the outgoing message text AND a synthetic placeholder bubble during the
 * tiny window between POST and DB-row Realtime arrival.
 */
function getBootstrapText(projectName: string, appUrl: string): string {
  return `I just set up ${projectName} (${appUrl}). Analyze my project data and suggest UI flows to test.`
}

/**
 * Generate a UIMessage-style id. Only the first character needs to be a
 * letter so JSON parsers never accidentally interpret it as a number;
 * otherwise any stable unique id is fine. We prefix with `u` so user-side
 * ids are trivially distinguishable from Python-side assistant ids (`va`).
 */
function generateClientMessageId(): string {
  return (
    'u' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  )
}

/**
 * Pending-message persistence across hard refreshes.
 *
 * The server's `chat_messages` upsert is the first real write during a
 * chat POST, but it still takes a few tens of ms to commit. If the user
 * hard-refreshes in that window, React state is wiped AND the DB row
 * isn't visible yet — so the bubble "disappears" even though the POST
 * goes on to complete server-side. We persist pending bubbles in
 * localStorage keyed by `client_message_id`, hydrate on mount, and let
 * the normal reconciliation paths (Realtime INSERT, fallback poll) drop
 * them the instant a matching DB row shows up.
 *
 * TTL guards against the truly-failed-POST case (no DB row ever arrives)
 * from leaving a ghost bubble sitting forever.
 */
type StoredPendingMessage = {
  clientId: string
  text: string
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000
const pendingStorageKey = (sessionId: string) => `chat-pending:${sessionId}`

function loadPendingFromStorage(sessionId: string): StoredPendingMessage[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(pendingStorageKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter(
      (p): p is StoredPendingMessage =>
        !!p &&
        typeof (p as StoredPendingMessage).clientId === 'string' &&
        typeof (p as StoredPendingMessage).text === 'string' &&
        typeof (p as StoredPendingMessage).createdAt === 'number' &&
        now - (p as StoredPendingMessage).createdAt < PENDING_TTL_MS,
    )
  } catch {
    return []
  }
}

function savePendingToStorage(
  sessionId: string,
  entries: StoredPendingMessage[],
): void {
  if (typeof window === 'undefined') return
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(pendingStorageKey(sessionId))
    } else {
      window.localStorage.setItem(
        pendingStorageKey(sessionId),
        JSON.stringify(entries),
      )
    }
  } catch {
    // Quota exceeded / private mode / disabled storage — non-fatal; the
    // pending bubble is still visible in memory, it just won't survive
    // a refresh.
  }
}

function addPendingToStorage(
  sessionId: string,
  entry: StoredPendingMessage,
): void {
  const current = loadPendingFromStorage(sessionId)
  const without = current.filter((p) => p.clientId !== entry.clientId)
  savePendingToStorage(sessionId, [...without, entry])
}

function removePendingFromStorage(sessionId: string, clientId: string): void {
  const current = loadPendingFromStorage(sessionId)
  const next = current.filter((p) => p.clientId !== clientId)
  if (next.length !== current.length) {
    savePendingToStorage(sessionId, next)
  }
}

interface ChatInterfaceProps {
  projectId: string
  sessionId: string
  initialMessages: ChatMessage[]
  initialSessionStatus: 'idle' | 'thinking' | 'error'
  initialStatusUpdatedAt: string | null
  /**
   * Whether a chat-triggered test run for this project was already in
   * flight at SSR time. Used to seed the "backend busy" gate so a hard
   * refresh during a running test keeps the input disabled and the poll
   * loop active from the first paint, without waiting a full poll
   * interval for the server to confirm.
   */
  initialHasActiveTestRun: boolean
  projectName: string
  appUrl: string
  /**
   * Whether the project's GitHub integration is configured and ready. When
   * `false` we skip the auto-bootstrap message (otherwise the server would
   * return GITHUB_SETUP_REQUIRED and toast-spam the user while the settings
   * overlay is already open for them to fix it).
   */
  githubReady: boolean
}

export function ChatInterface({
  projectId,
  sessionId,
  initialMessages,
  initialSessionStatus,
  initialStatusUpdatedAt,
  initialHasActiveTestRun,
  projectName,
  appUrl,
  githubReady: initialGithubReady,
}: ChatInterfaceProps) {
  const { openSettings } = useWorkspace()
  const githubReady = useGithubReady(projectId, initialGithubReady)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  /**
   * Optimistic approval overrides, keyed by (messageId, flowId) so clicks
   * on one proposal card set never spill into another's state. Realtime
   * UPDATE events clear the matching entries once the server write lands.
   *
   * Shape: { [messageId]: { [flowId]: 'approved' | 'rejected' } }
   */
  const [flowStatesOverride, setFlowStatesOverride] = useState<
    Record<string, Record<string, 'pending' | 'approved' | 'rejected'>>
  >({})
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>(initialMessages)
  /**
   * Optimistic user-message bubbles, keyed by the `client_message_id` we
   * generated for the request. We show them immediately on submit so the
   * chat feels responsive, then drop them the moment the matching DB row
   * lands via Realtime (matched on client_message_id).
   *
   * Hydrated from localStorage in a mount effect below so a hard refresh
   * during the POST-upsert window doesn't lose the bubble. Seeding here
   * as `[]` keeps SSR and the initial client render identical, avoiding
   * hydration mismatches.
   */
  const [pendingUserMessages, setPendingUserMessages] = useState<
    { clientId: string; text: string }[]
  >([])
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const lastBootstrapKeyRef = useRef<string | null>(null)
  const bootstrapFailureCountRef = useRef(0)
  const dbEmptyRef = useRef(initialMessages.length === 0)
  const [isPosting, setIsPosting] = useState(false)

  const computeSessionThinking = useCallback(
    (status: string, updatedAt: string | null) => {
      if (status !== 'thinking') return false
      if (!updatedAt) return true
      return Date.now() - new Date(updatedAt).getTime() < STALE_THINKING_MS
    },
    [],
  )

  const [backendThinking, setBackendThinking] = useState(() =>
    computeSessionThinking(initialSessionStatus, initialStatusUpdatedAt),
  )

  /**
   * Whether a chat-triggered test run is currently executing on Modal.
   *
   * This is a separate axis of "backend is busy" from `backendThinking`.
   * The LangGraph chat turn finalizes (flipping `chat_sessions.status`
   * back to `'idle'`) immediately after spawning `execute_test_run` —
   * long before the cloud browser is actually ready. Gating solely on
   * `backendThinking` would stop the poll loop at that point, and the
   * `live_session` chat bubble inserted a few seconds later by
   * `runner/execute.py` would never reach the UI until the user
   * refreshed or sent a follow-up message.
   *
   * We treat a run as active while `test_runs.status` is in
   * `pending`/`planning`/`running` (for a `trigger='chat'` row on this
   * session's project). The `/api/chat/session-state` endpoint returns
   * that signal on every poll tick; a non-null `activeTestRun` keeps
   * this true. See that route for the `ACTIVE_TEST_RUN_MAX_AGE_MS`
   * safety cap that prevents a stuck worker from permanently disabling
   * the chat input.
   */
  const [backendTestRunActive, setBackendTestRunActive] = useState(
    initialHasActiveTestRun,
  )

  useEffect(() => {
    dbEmptyRef.current = dbMessages.length === 0
  }, [dbMessages.length])

  // Hydrate pending bubbles from localStorage on mount so a hard refresh
  // during the POST-upsert window restores the optimistic bubble. We
  // filter against `initialMessages` (the SSR snapshot) so any entry the
  // server has already persisted is dropped — the DB-backed bubble will
  // render it instead. Runs once per session.
  useEffect(() => {
    const persistedClientIds = new Set(
      initialMessages
        .map((m) => m.client_message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    const stored = loadPendingFromStorage(sessionId)
    const stillPending = stored.filter(
      (p) => !persistedClientIds.has(p.clientId),
    )

    // Sync storage back so already-persisted / expired entries are pruned.
    if (stillPending.length !== stored.length) {
      savePendingToStorage(sessionId, stillPending)
    }

    if (stillPending.length > 0) {
      setPendingUserMessages((prev) => {
        const existing = new Set(prev.map((m) => m.clientId))
        const additions = stillPending
          .filter((p) => !existing.has(p.clientId))
          .map((p) => ({ clientId: p.clientId, text: p.text }))
        return additions.length === 0 ? prev : [...prev, ...additions]
      })
    }
    // `initialMessages` is a server-provided prop and stable per navigation;
    // we intentionally don't re-run when it changes mid-session, because
    // the Realtime + poll paths handle subsequent reconciliation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Centralized reconciliation: whenever `dbMessages` changes, drop any
  // pending bubble (and localStorage entry) whose `client_message_id` is
  // now persisted. This covers every path by which a DB row becomes
  // visible — Realtime INSERT, fallback poll, SSR seed — without each
  // path needing its own cleanup logic.
  useEffect(() => {
    const persistedClientIds = new Set(
      dbMessages
        .map((m) => m.client_message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    if (persistedClientIds.size === 0) return

    const stored = loadPendingFromStorage(sessionId)
    const remaining = stored.filter((p) => !persistedClientIds.has(p.clientId))
    if (remaining.length !== stored.length) {
      savePendingToStorage(sessionId, remaining)
    }

    setPendingUserMessages((prev) => {
      const next = prev.filter((m) => !persistedClientIds.has(m.clientId))
      return next.length === prev.length ? prev : next
    })
  }, [dbMessages, sessionId])

  /**
   * Per-message approval state map. Every `flow_proposals` row (active or
   * superseded) gets its own entry, so a click on an old card can never
   * mutate a new card's state. `activeProposalMessageId` identifies the
   * single `metadata.status === 'active'` row — the one whose approvals
   * feed `start_test_run` and the approved-count footer.
   */
  const { flowStatesByMessageId, activeProposalMessageId } = useMemo(() => {
    const byMessage: Record<
      string,
      Record<string, 'pending' | 'approved' | 'rejected'>
    > = {}
    let activeId: string | null = null
    for (const msg of dbMessages) {
      const meta = msg.metadata as Record<string, Json> | null
      if (meta?.type !== 'flow_proposals' || !meta.flow_states) continue
      const baseStates = meta.flow_states as Record<
        string,
        'pending' | 'approved' | 'rejected'
      >
      const override = flowStatesOverride[msg.id] ?? {}
      byMessage[msg.id] = { ...baseStates, ...override }
      // "status" is optional on legacy rows; treat missing as active.
      const status = (meta.status as string | undefined) ?? 'active'
      if (status === 'active') activeId = msg.id
    }
    return {
      flowStatesByMessageId: byMessage,
      activeProposalMessageId: activeId,
    }
  }, [dbMessages, flowStatesOverride])

  /**
   * Send a message to the backend. Lives in one place so the bootstrap
   * effect and the input form can share it. Fire-and-forget from the
   * caller's perspective — we optimistically show the user bubble, then
   * let Realtime reconcile when the DB row lands.
   */
  const sendChatMessage = useCallback(
    async (
      text: string,
      options?: { clientId?: string },
    ): Promise<{ ok: boolean; code?: string }> => {
      const clientId = options?.clientId ?? generateClientMessageId()
      setPendingUserMessages((prev) => [...prev, { clientId, text }])
      // Persist the pending bubble so a hard refresh during the POST —
      // particularly before the server commits its `chat_messages`
      // upsert — can rehydrate the bubble on the next mount. Cleaned up
      // by the dbMessages-reconciliation effect once the DB row is
      // visible, or below if the POST fails outright.
      addPendingToStorage(sessionId, {
        clientId,
        text,
        createdAt: Date.now(),
      })
      setIsPosting(true)
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            message: { id: clientId, text },
          }),
        })

        if (res.status === 202) {
          // The server wrote `status='thinking'` on `chat_sessions` just before
          // spawning the Modal worker. Flip the spinner on locally so the UI
          // doesn't rely on Realtime to deliver that UPDATE — the WS channel
          // may still be joining on first mount, and Realtime does not replay
          // events that occurred before SUBSCRIBED. Realtime is still the
          // authoritative source for flipping back to `idle` when the turn
          // completes; by then the channel has long since joined.
          setBackendThinking(true)
          return { ok: true }
        }

        // Try to surface the structured server error.
        let errorMessage = 'Could not reach Verona. Check your connection and try again.'
        let code: string | undefined
        try {
          const ct = res.headers.get('content-type') ?? ''
          if (ct.includes('application/json')) {
            const data = (await res.json()) as { error?: string; code?: string }
            if (data?.error) errorMessage = data.error
            if (data?.code) code = data.code
          }
        } catch {
          /* ignore */
        }

        if (code === 'GITHUB_SETUP_REQUIRED') {
          toast.error(errorMessage)
          openSettings(projectId)
        } else if (code === 'TURN_IN_FLIGHT') {
          // 409 — a previous turn is still running and the server did
          // NOT persist this new message. Surface a non-error toast so
          // the user understands they need to wait; they can re-send
          // after the current turn's assistant reply lands.
          toast(errorMessage)
        } else {
          toast.error(errorMessage)
        }
        // Drop the optimistic bubble — the message didn't land in the DB
        // regardless of which non-202 path we took. Also clear storage so
        // a refresh doesn't rehydrate a ghost bubble.
        setPendingUserMessages((prev) => prev.filter((m) => m.clientId !== clientId))
        removePendingFromStorage(sessionId, clientId)
        return { ok: false, code }
      } catch (err) {
        console.error('Chat request failed:', err)
        toast.error('Could not reach Verona. Check your connection and try again.')
        setPendingUserMessages((prev) => prev.filter((m) => m.clientId !== clientId))
        removePendingFromStorage(sessionId, clientId)
        return { ok: false }
      } finally {
        setIsPosting(false)
      }
    },
    [projectId, openSettings, sessionId],
  )

  // Reset the bootstrap retry counter when GitHub becomes ready.
  const prevGithubReadyRef = useRef(githubReady)
  useEffect(() => {
    if (!prevGithubReadyRef.current && githubReady) {
      bootstrapFailureCountRef.current = 0
      lastBootstrapKeyRef.current = null
    }
    prevGithubReadyRef.current = githubReady
  }, [githubReady])

  useEffect(() => {
    if (dbMessages.length > 0) {
      bootstrapFailureCountRef.current = 0
      return
    }
    if (!githubReady) return
    if (backendThinking) return

    const key = `${sessionId}:${bootstrapNonce}`
    if (lastBootstrapKeyRef.current === key) return
    lastBootstrapKeyRef.current = key

    /**
     * Deterministic message id so a refresh / tab-close that re-fires
     * this effect upserts into the same `chat_messages` row on the server
     * (unique on `session_id, client_message_id`), and the Modal-side
     * duplicate guard short-circuits without spawning a second turn.
     * The nonce is appended so an explicit retry after a failure gets a
     * fresh id.
     */
    const bootstrapClientId = `bootstrap:${sessionId}:${bootstrapNonce}`
    const bootstrapText = getBootstrapText(projectName, appUrl)

    void sendChatMessage(bootstrapText, { clientId: bootstrapClientId }).then(
      (result) => {
        if (!result.ok) {
          // Only retry on generic network/5xx-style failures. Specifically
          // skip retry on structured rejections that indicate the turn is
          // unreachable by design (TURN_IN_FLIGHT means a previous turn is
          // still running and the server did not accept this message —
          // retrying immediately would just hit the same guard).
          const isStructuredRejection =
            result.code === 'GITHUB_SETUP_REQUIRED' ||
            result.code === 'TURN_IN_FLIGHT'
          if (
            dbEmptyRef.current &&
            bootstrapFailureCountRef.current < 2 &&
            !isStructuredRejection
          ) {
            bootstrapFailureCountRef.current += 1
            lastBootstrapKeyRef.current = null
            setBootstrapNonce((n) => n + 1)
          }
        }
      },
    )
  }, [
    dbMessages.length,
    bootstrapNonce,
    backendThinking,
    githubReady,
    sessionId,
    projectName,
    appUrl,
    sendChatMessage,
  ])

  // Poll `/api/chat/session-state` while any backend work for this
  // session is in flight.
  //
  // Replaces the previous Supabase Realtime subscriptions + 3-timer REST
  // fallback. `postgres_changes` is too unreliable for a handful of events
  // spread over 60-120 s — a single missed INSERT/UPDATE left the UI stuck
  // on "thinking" until a full page reload. Polling against a single
  // combined endpoint is deterministic, debuggable, and bounded by turn
  // duration.
  //
  // "In flight" here spans TWO kinds of Modal work:
  //   1. The LangGraph chat turn (`chat_sessions.status='thinking'`).
  //   2. A chat-triggered test run (`test_runs.status IN
  //      ('pending','planning','running')` with `trigger='chat'` on
  //      this session's project).
  //
  // Both surface via the single `/api/chat/session-state` response. We
  // keep polling until both are clear — otherwise the `live_session`
  // chat bubble that `execute_test_run` inserts AFTER the chat-turn
  // finalize would never be observed in realtime.
  //
  // Each tick gets back `{ status, statusUpdatedAt, newMessages, activeTestRun }`
  // in one atomic snapshot. The server orders finalize's message upsert
  // BEFORE flipping session status to 'idle' (runner/chat/nodes.py), so
  // the "status=idle" response always carries the final chat-turn
  // message rows — no extra flush tick needed. Similarly, the runner
  // updates the `live_session` chat_messages row BEFORE flipping
  // `test_runs.status` to a terminal state, so the "activeTestRun=null"
  // response always carries the final run-status update on the bubble.
  //
  // Cadence: 2.5 s baseline, with an immediate first tick so short
  // follow-up turns don't block on a delay. Tab backgrounding is handled
  // implicitly by browser setTimeout throttling; a `visibilitychange`
  // listener kicks a one-shot catch-up poll on refocus so the UI feels
  // snappy when returning to a backgrounded tab.
  //
  // Completion reconciliation:
  //   - Optimistic user bubbles are dropped by the existing dbMessages-
  //     reconciliation effect above (matches on client_message_id).
  //   - Per-message `flowStatesOverride[messageId]` is cleared when the
  //     server-side `flow_states` for that row updates, so approve/reject
  //     round-trips stop masking the server truth. We scope clears by
  //     messageId (not a blanket reset) because multiple `flow_proposals`
  //     rows can coexist — one active + zero or more superseded — and
  //     only the clicked row's overrides should drop.
  const isTurnInFlight = isPosting || backendThinking || backendTestRunActive
  useEffect(() => {
    if (!isTurnInFlight) return

    let cancelled = false
    const abortController = new AbortController()

    // Cursor held in closure, advanced after each successful merge. We
    // intentionally do NOT depend on `dbMessages` in the effect deps —
    // that would tear down and rebuild the loop on every tick.
    let sinceCursor: string | null = (() => {
      if (dbMessages.length === 0) return null
      const last = dbMessages[dbMessages.length - 1]
      return last?.created_at ?? null
    })()

    const mergeMessages = (rows: ChatMessage[]) => {
      if (rows.length === 0) return
      // Collect ids of flow_proposals rows whose server-side state we
      // just observed, so we can drop per-message overrides scoped to
      // those ids (a click that's now reflected on the server should
      // stop masking the server truth).
      const updatedProposalIds: string[] = []
      setDbMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]))
        for (const row of rows) {
          const safe: ChatMessage = { ...row, content: row.content ?? '' }
          byId.set(row.id, safe)
          const meta = row.metadata as Record<string, Json> | null
          if (meta?.flow_states && meta?.type === 'flow_proposals') {
            updatedProposalIds.push(row.id)
          }
        }
        return Array.from(byId.values()).sort(
          (a, b) =>
            new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime(),
        )
      })
      // Only advance the cursor using INSERT-shaped rows (created_at
      // greater than the current cursor). Don't advance past rows whose
      // created_at is <= cursor — those are UPDATEs to historical rows
      // (e.g. metadata.status='superseded') and shouldn't shift the
      // delta window forward.
      for (const row of rows) {
        if (!row.created_at) continue
        if (!sinceCursor || row.created_at > sinceCursor) {
          sinceCursor = row.created_at
        }
      }
      if (updatedProposalIds.length > 0) {
        setFlowStatesOverride((prev) => {
          let changed = false
          const next: typeof prev = { ...prev }
          for (const id of updatedProposalIds) {
            if (next[id]) {
              delete next[id]
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
    }

    const pollOnce = async (): Promise<'stop' | 'continue'> => {
      const url = new URL('/api/chat/session-state', window.location.origin)
      url.searchParams.set('sessionId', sessionId)
      if (sinceCursor) url.searchParams.set('since', sinceCursor)

      let res: Response
      try {
        res = await fetch(url.toString(), { signal: abortController.signal })
      } catch (err) {
        if (abortController.signal.aborted) return 'stop'
        // Transient network error — log and let the loop retry on the
        // next tick. No backoff: the 2.5 s cadence is already gentle and
        // giving up on a flaky connection is worse UX than re-trying.
        console.warn('session-state fetch failed', err)
        return 'continue'
      }

      if (res.status === 404) {
        // Session was deleted out from under us. Nothing more to poll.
        return 'stop'
      }
      if (!res.ok) {
        console.warn('session-state fetch non-ok', res.status)
        return 'continue'
      }

      let data: {
        status: 'idle' | 'thinking' | 'error'
        statusUpdatedAt: string | null
        newMessages: ChatMessage[]
        activeTestRun: {
          id: string
          status: string
          createdAt: string
        } | null
      }
      try {
        data = (await res.json()) as typeof data
      } catch (err) {
        console.warn('session-state parse failed', err)
        return 'continue'
      }

      if (cancelled) return 'stop'

      mergeMessages(data.newMessages)

      const stillThinking = computeSessionThinking(
        data.status,
        data.statusUpdatedAt,
      )
      setBackendThinking(stillThinking)

      const stillRunningTest = data.activeTestRun !== null
      setBackendTestRunActive(stillRunningTest)

      // Keep polling while EITHER axis of backend work is active. The
      // chat-turn finalize races the test-run start, so we can't
      // collapse these into a single "busy" flag server-side without
      // losing correctness — the client has to observe both.
      return stillThinking || stillRunningTest ? 'continue' : 'stop'
    }

    const POLL_INTERVAL_MS = 2500

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = window.setTimeout(resolve, ms)
        abortController.signal.addEventListener(
          'abort',
          () => {
            window.clearTimeout(t)
            resolve()
          },
          { once: true },
        )
      })

    void (async () => {
      // Fire the first tick immediately — no reason to wait 2.5 s for
      // the first update, and short follow-up turns often finish in
      // under a second.
      while (!cancelled) {
        const decision = await pollOnce()
        if (decision === 'stop' || cancelled) return
        await sleep(POLL_INTERVAL_MS)
      }
    })()

    // Refocus catch-up: when the user returns to a backgrounded tab,
    // the throttled setTimeout may be seconds behind. A single immediate
    // poll makes the UI feel current on refocus without changing the
    // steady-state cadence.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        void pollOnce()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      abortController.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    // We intentionally omit `dbMessages` from deps; the cursor is a
    // closure local advanced by mergeMessages. Re-running on every
    // message arrival would tear down the poll loop on each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTurnInFlight, sessionId, computeSessionThinking])

  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const updateStickToBottomFromScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
    setShowJumpToBottom(distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX * 3)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateStickToBottomFromScroll, { passive: true })
    updateStickToBottomFromScroll()
    return () => el.removeEventListener('scroll', updateStickToBottomFromScroll)
  }, [updateStickToBottomFromScroll])

  const scrollPaneToBottomIfStuck = useCallback(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stickToBottomRef.current = true
    setShowJumpToBottom(false)
  }, [])

  useEffect(() => {
    scrollPaneToBottomIfStuck()
  }, [dbMessages, pendingUserMessages, scrollPaneToBottomIfStuck])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      scrollPaneToBottomIfStuck()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scrollPaneToBottomIfStuck])

  /**
   * Per-card approve/reject. `messageId` is the proposals row this click
   * belongs to — critical for correctness now that the chat can contain
   * multiple proposals rows (one active + zero or more superseded). The
   * server rejects writes against superseded rows with 409
   * PROPOSALS_SUPERSEDED; we surface that and roll back the optimistic
   * override so the UI stays consistent.
   */
  const patchFlowState = useCallback(
    async (
      messageId: string,
      flowId: string,
      action: 'approve' | 'reject',
    ) => {
      const optimisticState: 'approved' | 'rejected' =
        action === 'approve' ? 'approved' : 'rejected'
      setFlowStatesOverride((prev) => ({
        ...prev,
        [messageId]: { ...(prev[messageId] ?? {}), [flowId]: optimisticState },
      }))

      const rollback = () => {
        setFlowStatesOverride((prev) => {
          const forMsg = prev[messageId]
          if (!forMsg || !(flowId in forMsg)) return prev
          const rest = { ...forMsg }
          delete rest[flowId]
          const next = { ...prev }
          if (Object.keys(rest).length === 0) {
            delete next[messageId]
          } else {
            next[messageId] = rest
          }
          return next
        })
      }

      try {
        const res = await fetch('/api/chat/flows', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId, flowId, action }),
        })
        if (res.ok) return
        let code: string | undefined
        let errorMessage = 'Could not update flow. Try again.'
        try {
          const ct = res.headers.get('content-type') ?? ''
          if (ct.includes('application/json')) {
            const data = (await res.json()) as { error?: string; code?: string }
            if (data?.error) errorMessage = data.error
            if (data?.code) code = data.code
          }
        } catch {
          /* ignore */
        }
        rollback()
        if (code === 'PROPOSALS_SUPERSEDED') {
          toast(errorMessage)
        } else {
          toast.error(errorMessage)
        }
      } catch (err) {
        console.error('Flow approve/reject failed:', err)
        rollback()
        toast.error('Could not update flow. Check your connection and try again.')
      }
    },
    [],
  )

  const handleApproveFlow = useCallback(
    (messageId: string, flowId: string) => {
      void patchFlowState(messageId, flowId, 'approve')
    },
    [patchFlowState],
  )

  const handleRejectFlow = useCallback(
    (messageId: string, flowId: string) => {
      void patchFlowState(messageId, flowId, 'reject')
    },
    [patchFlowState],
  )

  const trySend = useCallback(() => {
    if (!githubReady) {
      toast.error('Connect GitHub to start chatting with Verona.')
      openSettings(projectId)
      return
    }
    const trimmed = input.trim()
    if (!trimmed || isPosting) return
    stickToBottomRef.current = true
    void sendChatMessage(trimmed)
    setInput('')
    requestAnimationFrame(() => {
      scrollPaneToBottomIfStuck()
      requestAnimationFrame(() => scrollPaneToBottomIfStuck())
    })
  }, [
    githubReady,
    input,
    isPosting,
    openSettings,
    projectId,
    scrollPaneToBottomIfStuck,
    sendChatMessage,
  ])

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    trySend()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      trySend()
    }
  }

  // Approved-count reflects only the single ACTIVE proposals row. Approvals on
  // superseded rows are historical and never execute; counting them would
  // show a misleading footer total.
  const approvedCount = useMemo(() => {
    if (!activeProposalMessageId) return 0
    const active = flowStatesByMessageId[activeProposalMessageId] ?? {}
    return Object.values(active).filter((s) => s === 'approved').length
  }, [activeProposalMessageId, flowStatesByMessageId])
  const isProcessing = isTurnInFlight

  const displayMessages = useMemo(() => {
    const dbRendered = dbMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content ?? '',
        metadata: m.metadata as Record<string, Json> | undefined,
      }))

    // Optimistic user bubbles not yet reflected in DB via Realtime.
    const persistedClientIds = new Set(
      dbMessages
        .map((m) => m.client_message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    const pendingBubbles = pendingUserMessages
      .filter((m) => !persistedClientIds.has(m.clientId))
      .map((m) => ({
        id: `pending:${m.clientId}`,
        role: 'user' as const,
        content: m.text,
        metadata: undefined as Record<string, Json> | undefined,
      }))

    return [...dbRendered, ...pendingBubbles]
  }, [dbMessages, pendingUserMessages])

  return (
    <div className="relative flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-6 py-8 space-y-8">
          {displayMessages.length === 0 && !isProcessing && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="size-10 rounded-full bg-foreground/5 flex items-center justify-center">
                <span className="text-lg font-medium text-foreground/60">V</span>
              </div>
              <h2 className="text-2xl font-normal text-foreground/90 tracking-tight">
                What shall we test in {projectName}?
              </h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                I&apos;ll analyze your app, PostHog events, and repo to propose flows worth testing.
              </p>
            </div>
          )}

          {displayMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              projectId={projectId}
              messageId={msg.id}
              role={msg.role}
              content={msg.content}
              metadata={msg.metadata}
              flowStates={flowStatesByMessageId[msg.id]}
              onApproveFlow={handleApproveFlow}
              onRejectFlow={handleRejectFlow}
              isStreaming={false}
            />
          ))}

          {/**
           * Thinking indicator is driven entirely by backend state
           * (chat_sessions.status). This means: the turn runs on Modal, the
           * Python worker writes `status='thinking'` at start and `status='idle'`
           * on exit, Supabase Realtime pushes the change, the client flips
           * the indicator. Hard-refresh: the page SSR'd with whatever status
           * was current, so the spinner appears if a turn is still in flight.
           */}
          {isProcessing && (
            <div className="space-y-3">
              {/**
               * One-time heads-up while the bootstrap turn is in flight: no
               * assistant has ever replied on this session, so this is the
               * initial analyze-and-propose pass which can take a while. We
               * key off "no assistant message has arrived yet" rather than
               * the bootstrap nonce so hard-refreshes mid-bootstrap still
               * show it. Disappears as soon as the first assistant bubble
               * lands.
               */}
              {!displayMessages.some((m) => m.role === 'assistant') && (
                <p className="text-[15px] leading-[1.7] text-foreground">
                  I&apos;m analyzing your app and finding UI flows worth
                  testing. This may take a little while — feel free to
                  navigate away, I&apos;ll keep working in the background.
                </p>
              )}
              <ThinkingIndicator />
            </div>
          )}
        </div>
      </div>

      {/*
       * Bottom group: the "N flows approved" pill (when shown) and the chat
       * input, plus the gradient fade and jump-to-latest pill that float just
       * above this group.
       *
       * We anchor the gradient and jump-to-latest pill to the TOP of this
       * wrapper (`bottom-full`) instead of using fixed pixel offsets from the
       * page bottom. This guarantees they always sit immediately above
       * whatever the bottom group currently contains — input only, or input
       * plus approved-pill — and never overlap or conflict with the approved
       * pill regardless of its presence.
       */}
      <div className="relative shrink-0">
        {/* gradient fade into bottom group */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
        />

        {/* jump-to-latest pill, floating just above the bottom group */}
        {showJumpToBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full mb-3 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={jumpToBottom}
              className="pointer-events-auto rounded-full bg-background shadow-sm text-xs gap-1.5 h-8 px-3"
            >
              <ArrowDown className="size-3.5" />
              Jump to latest
            </Button>
          </div>
        )}

        {/*
         * The "N flows approved · Tell me to 'start testing' when ready" pill is a
         * call-to-action prompting the user to kick off a run. While a test run is
         * already in flight (pending/planning/running on this project) the prompt
         * is stale and visually noisy, so we suppress it for the duration of the
         * run. `backendTestRunActive` flips back to false the moment the run hits
         * a terminal state (via the session-state poll's atomic snapshot), and the
         * pill returns automatically — communicating to the user that the same N
         * approved flows are still queued and ready to be re-run on demand.
         *
         * We deliberately key off `backendTestRunActive` rather than the broader
         * `isTurnInFlight`: hiding the pill while Verona is merely "thinking" or
         * while a user POST is in flight would be jarring and unrelated to the
         * pill's actual semantics.
         */}
        {approvedCount > 0 && !backendTestRunActive && (
          <div className="relative z-10 mx-auto w-full max-w-[760px] px-6 pb-2">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-green-500" />
              <span>{approvedCount} flow{approvedCount !== 1 ? 's' : ''} approved</span>
              <span className="text-muted-foreground/40">·</span>
              <span>Tell me to start testing when ready, or propose changes</span>
            </div>
          </div>
        )}

        <div className="mx-auto w-full max-w-[760px] px-6 pb-4 pt-2">
          <ChatInputForm
            githubReady={githubReady}
            isProcessing={isProcessing}
            input={input}
            setInput={setInput}
            handleSubmit={handleSubmit}
            handleKeyDown={handleKeyDown}
            inputRef={inputRef}
          />
        </div>
      </div>
    </div>
  )
}

function ChatInputForm({
  githubReady,
  isProcessing,
  input,
  setInput,
  handleSubmit,
  handleKeyDown,
  inputRef,
}: {
  githubReady: boolean
  isProcessing: boolean
  input: string
  setInput: (value: string) => void
  handleSubmit: (e: SyntheticEvent<HTMLFormElement>) => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const disabled = isProcessing || !githubReady

  const form = (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'relative rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-foreground/25',
        !githubReady && 'opacity-70',
      )}
    >
      <Textarea
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          !githubReady
            ? 'Connect GitHub to start chatting…'
            : isProcessing
              ? 'Verona is working — please wait…'
              : 'Reply…'
        }
        rows={1}
        aria-busy={isProcessing}
        className="resize-none border-0 bg-transparent min-h-[56px] max-h-[200px] pl-4 pr-14 py-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-70"
        disabled={disabled}
      />
      <Button
        type="submit"
        size="icon"
        disabled={disabled || !input.trim()}
        className="absolute bottom-2.5 right-2.5 size-8 rounded-full"
        aria-label={
          !githubReady
            ? 'Connect GitHub to send a message'
            : isProcessing
              ? 'Sending'
              : 'Send message'
        }
      >
        {isProcessing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ArrowUp className="size-4" />
        )}
      </Button>
    </form>
  )

  if (githubReady) return form

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="block" />}>{form}</TooltipTrigger>
      <TooltipContent side="top" align="center" className="max-w-[260px] text-center leading-snug">
        Connect GitHub in settings before chatting with Verona.
      </TooltipContent>
    </Tooltip>
  )
}
