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
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useGithubReady } from '@/lib/settings-prefetch'

/**
 * Supabase UPDATE payloads may include only changed columns; merge so we
 * never drop `content` when a late status-only update arrives.
 */
function mergeChatMessageRow(prev: ChatMessage, patch: ChatMessage): ChatMessage {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<ChatMessage>
  const merged = { ...prev, ...defined }
  if (merged.content == null) {
    merged.content = prev.content ?? ''
  }
  return merged
}

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

interface ChatInterfaceProps {
  projectId: string
  sessionId: string
  initialMessages: ChatMessage[]
  initialSessionStatus: 'idle' | 'thinking' | 'error'
  initialStatusUpdatedAt: string | null
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
  const [flowStatesOverride, setFlowStatesOverride] = useState<
    Record<string, 'pending' | 'approved' | 'rejected'> | null
  >(null)
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>(initialMessages)
  /**
   * Optimistic user-message bubbles, keyed by the `client_message_id` we
   * generated for the request. We show them immediately on submit so the
   * chat feels responsive, then drop them the moment the matching DB row
   * lands via Realtime (matched on client_message_id).
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

  useEffect(() => {
    dbEmptyRef.current = dbMessages.length === 0
  }, [dbMessages.length])

  const { flowStates, proposalMessageId } = useMemo(() => {
    let states: Record<string, 'pending' | 'approved' | 'rejected'> = {}
    let msgId: string | null = null
    for (const msg of dbMessages) {
      const meta = msg.metadata as Record<string, Json> | null
      if (meta?.type === 'flow_proposals' && meta.flow_states) {
        states = meta.flow_states as Record<string, 'pending' | 'approved' | 'rejected'>
        msgId = msg.id
      }
    }
    if (flowStatesOverride) {
      states = { ...states, ...flowStatesOverride }
    }
    return { flowStates: states, proposalMessageId: msgId }
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
        } else {
          toast.error(errorMessage)
        }
        // Drop the optimistic bubble on hard failure — the message didn't land.
        setPendingUserMessages((prev) => prev.filter((m) => m.clientId !== clientId))
        return { ok: false, code }
      } catch (err) {
        console.error('Chat request failed:', err)
        toast.error('Could not reach Verona. Check your connection and try again.')
        setPendingUserMessages((prev) => prev.filter((m) => m.clientId !== clientId))
        return { ok: false }
      } finally {
        setIsPosting(false)
      }
    },
    [projectId, openSettings],
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
          if (
            dbEmptyRef.current &&
            bootstrapFailureCountRef.current < 2 &&
            result.code !== 'GITHUB_SETUP_REQUIRED'
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

  // Realtime subscription to chat_messages — the only source of visible bubbles.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`chat-${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessage
          setDbMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev
            const safe: ChatMessage = {
              ...newMsg,
              content: newMsg.content ?? '',
            }
            return [...prev, safe]
          })

          // Reconcile optimistic bubbles: if the server-persisted row
          // matches one we were tracking, drop the placeholder.
          if (newMsg.client_message_id) {
            setPendingUserMessages((prev) =>
              prev.filter((m) => m.clientId !== newMsg.client_message_id),
            )
          }

          if ((newMsg.metadata as Record<string, Json> | null)?.type === 'flow_proposals') {
            setFlowStatesOverride(null)
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_messages',
          filter: `session_id=eq.${sessionId}`,
        },
        (payload) => {
          const updated = payload.new as ChatMessage
          setDbMessages((prev) =>
            prev.map((m) =>
              m.id === updated.id ? mergeChatMessageRow(m, updated) : m,
            ),
          )
          if ((updated.metadata as Record<string, Json> | null)?.flow_states) {
            setFlowStatesOverride(null)
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  // Session status Realtime — drives the `thinking` indicator.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`session-status-${sessionId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_sessions',
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          const row = payload.new as { status?: string; status_updated_at?: string }
          if (row.status) {
            setBackendThinking(
              computeSessionThinking(row.status, row.status_updated_at ?? null),
            )
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId, computeSessionThinking])

  // Realtime-fallback poll: occasionally re-fetch chat messages by REST
  // in case a Realtime message was dropped (e.g. during a brief WS hiccup).
  // Kept as a safety net — shouldn't be needed in the happy path, but
  // inexpensive and invisible when Realtime is healthy.
  useEffect(() => {
    const mergeFromServer = (rows: ChatMessage[]) => {
      setDbMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]))
        for (const row of rows) {
          byId.set(row.id, row)
        }
        return Array.from(byId.values()).sort(
          (a, b) =>
            new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime(),
        )
      })
    }

    const load = async () => {
      try {
        const res = await fetch(
          `/api/chat/messages?sessionId=${encodeURIComponent(sessionId)}&limit=100`,
        )
        if (!res.ok) return
        const rows = (await res.json()) as ChatMessage[]
        if (Array.isArray(rows)) mergeFromServer(rows)
      } catch {
        /* ignore */
      }
    }

    // Run a few catch-up fetches after mount; nothing fancy.
    const timeouts = [2000, 8000, 20000].map((ms) =>
      window.setTimeout(() => void load(), ms),
    )
    return () => timeouts.forEach(clearTimeout)
  }, [sessionId])

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

  const handleApproveFlow = useCallback(
    async (flowId: string) => {
      if (!proposalMessageId) return
      setFlowStatesOverride((prev) => ({ ...prev, [flowId]: 'approved' }))
      await fetch('/api/chat/flows', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: proposalMessageId,
          flowId,
          action: 'approve',
        }),
      })
    },
    [proposalMessageId],
  )

  const handleRejectFlow = useCallback(
    async (flowId: string) => {
      if (!proposalMessageId) return
      setFlowStatesOverride((prev) => ({ ...prev, [flowId]: 'rejected' }))
      await fetch('/api/chat/flows', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: proposalMessageId,
          flowId,
          action: 'reject',
        }),
      })
    },
    [proposalMessageId],
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

  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length
  const isProcessing = isPosting || backendThinking

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
              role={msg.role}
              content={msg.content}
              metadata={msg.metadata}
              flowStates={flowStates}
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
          {isProcessing && <ThinkingIndicator />}
        </div>
      </div>

      {/* gradient fade into input bar */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[96px] h-8 bg-gradient-to-t from-background to-transparent"
      />

      {/* jump-to-latest pill */}
      {showJumpToBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[108px] flex justify-center">
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

      {approvedCount > 0 && (
        <div className="mx-auto w-full max-w-[760px] px-6 pb-2 shrink-0">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-green-500" />
            <span>{approvedCount} flow{approvedCount !== 1 ? 's' : ''} approved</span>
            <span className="text-muted-foreground/40">·</span>
            <span>Tell me to &quot;start testing&quot; when ready</span>
          </div>
        </div>
      )}

      <div className="shrink-0">
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
