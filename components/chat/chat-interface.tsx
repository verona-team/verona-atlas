'use client'

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type SyntheticEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { ArrowUp, ArrowDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { MessageBubble } from './message-bubble'
import { ThinkingIndicator } from './thinking-indicator'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { Json, ChatMessage } from '@/lib/supabase/types'
import { createClient } from '@/lib/supabase/client'

function getTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
}

/** Realtime UPDATE payloads may include only changed columns; merge so we never drop `content`. */
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

/**
 * Extract the text we want to render in the assistant bubble for an in-flight
 * stream message. For text-only turns this is the concatenated text parts.
 *
 * For tool-only turns we return '' on success — the tool inserts its own DB
 * row (e.g. a `flow_proposals` row with approvable cards) that renders
 * separately. We still surface a short line for failures so the user isn't
 * left looking at a spinner that never completes.
 */
function getVisibleTextFromMessageParts(
  role: string,
  parts: Array<{
    type: string
    text?: string
    state?: string
    errorText?: string
    output?: unknown
  }>,
): string {
  const plain = getTextFromParts(parts)
  if (role !== 'assistant' || plain.length > 0) return plain

  for (const p of parts) {
    if (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) {
      if (p.state === 'output-error' && p.errorText) {
        return `Something went wrong: ${p.errorText}`
      }
      if (p.state === 'output-available' && p.output && typeof p.output === 'object') {
        const o = p.output as Record<string, unknown>
        if (o.success === false && typeof o.error === 'string') {
          return `Could not save proposals: ${o.error}`
        }
      }
    }
  }
  return ''
}

const STALE_THINKING_MS = 15 * 60 * 1000

const NEAR_BOTTOM_THRESHOLD_PX = 96

interface ChatInterfaceProps {
  projectId: string
  sessionId: string
  initialMessages: ChatMessage[]
  initialSessionStatus: 'idle' | 'thinking' | 'error'
  initialStatusUpdatedAt: string | null
  projectName: string
  appUrl: string
}

export function ChatInterface({
  projectId,
  sessionId,
  initialMessages,
  initialSessionStatus,
  initialStatusUpdatedAt,
  projectName,
  appUrl,
}: ChatInterfaceProps) {
  const router = useRouter()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [flowStatesOverride, setFlowStatesOverride] = useState<Record<string, 'pending' | 'approved' | 'rejected'> | null>(null)
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>(initialMessages)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const lastBootstrapKeyRef = useRef<string | null>(null)
  const bootstrapFailureCountRef = useRef(0)
  const dbEmptyRef = useRef(initialMessages.length === 0)

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

  const chatFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init)
      if (res.status === 400) {
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('application/json')) {
          const data = (await res.clone().json().catch(() => null)) as {
            code?: string
            error?: string
          } | null
          if (data?.code === 'GITHUB_SETUP_REQUIRED' && data.error) {
            toast.error(data.error)
            router.push(`/projects/${projectId}/settings`)
            return res
          }
        }
      }
      return res
    },
    [projectId, router],
  )

  const { messages: streamMessages, sendMessage, status } = useChat({
    id: `project-${projectId}`,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { projectId },
      fetch: chatFetch,
    }),
    onError: (err) => {
      console.error('Chat request failed:', err)
      toast.error('Could not reach Verona. Check your connection and try again.')
      if (
        dbEmptyRef.current &&
        bootstrapFailureCountRef.current < 2
      ) {
        bootstrapFailureCountRef.current += 1
        lastBootstrapKeyRef.current = null
        setBootstrapNonce((n) => n + 1)
      } else if (dbEmptyRef.current) {
        toast.error('Failed to start the analysis. Type a message below to retry.')
      }
    },
  })

  useEffect(() => {
    if (dbMessages.length > 0) {
      bootstrapFailureCountRef.current = 0
      return
    }

    if (backendThinking) return

    const key = `${sessionId}:${bootstrapNonce}`
    if (lastBootstrapKeyRef.current === key) return
    lastBootstrapKeyRef.current = key

    void sendMessage({
      text: `I just set up ${projectName} (${appUrl}). Analyze my project data and suggest UI flows to test.`,
    })
  }, [
    dbMessages.length,
    bootstrapNonce,
    backendThinking,
    sessionId,
    projectName,
    appUrl,
    sendMessage,
  ])

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

  useEffect(() => {
    if (status !== 'ready') return

    const mergeFromServer = (rows: ChatMessage[]) => {
      setDbMessages((prev) => {
        const byId = new Map(prev.map((m) => [m.id, m]))
        for (const row of rows) {
          byId.set(row.id, row)
        }
        return Array.from(byId.values()).sort(
          (a, b) =>
            new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime(),
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

    const timeouts = [400, 2000, 6000, 15000].map((ms) =>
      window.setTimeout(() => void load(), ms),
    )
    return () => timeouts.forEach(clearTimeout)
  }, [status, sessionId])

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
  }, [streamMessages, dbMessages, scrollPaneToBottomIfStuck])

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

  const handleSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (input.trim() && status === 'ready') {
      stickToBottomRef.current = true
      sendMessage({ text: input })
      setInput('')
      requestAnimationFrame(() => {
        scrollPaneToBottomIfStuck()
        requestAnimationFrame(() => scrollPaneToBottomIfStuck())
      })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim() && status === 'ready') {
        stickToBottomRef.current = true
        sendMessage({ text: input })
        setInput('')
        requestAnimationFrame(() => {
          scrollPaneToBottomIfStuck()
          requestAnimationFrame(() => scrollPaneToBottomIfStuck())
        })
      }
    }
  }

  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length
  const isStreamActive = status === 'submitted' || status === 'streaming'
  const isProcessing = isStreamActive || backendThinking

  const thinkingStartRef = useRef<number | null>(null)
  const [thinkingStart, setThinkingStart] = useState<number | null>(null)
  useEffect(() => {
    if (isProcessing && thinkingStartRef.current == null) {
      thinkingStartRef.current = Date.now()
      setThinkingStart(thinkingStartRef.current)
    } else if (!isProcessing && thinkingStartRef.current != null) {
      thinkingStartRef.current = null
      setThinkingStart(null)
    }
  }, [isProcessing])

  const displayMessages = useMemo(() => {
    const dbRendered = dbMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content ?? '',
        metadata: m.metadata as Record<string, Json> | undefined,
        isStreaming: false,
      }))

    const streamAsDisplay = streamMessages
      .map((m) => {
        const rawParts =
          (m as { parts: Array<{ type: string; text?: string }> }).parts ?? []
        const text = getVisibleTextFromMessageParts(
          m.role,
          rawParts as Array<{
            type: string
            text?: string
            state?: string
            errorText?: string
            output?: unknown
          }>,
        )
        return {
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: text,
          metadata: undefined as Record<string, Json> | undefined,
          isStreaming: isStreamActive && m.role === 'assistant',
        }
      })
      .filter((m) => m.content.length > 0)

    /**
     * Dedup stream messages against DB messages by id. The server persists
     * each assistant turn with `client_message_id` set to the same UIMessage
     * id the client holds in `streamMessages`, so a stream message is
     * considered already persisted iff a DB row has a matching
     * `client_message_id`. Same story for the user turn. No fuzzy text
     * comparisons, no timestamp fallbacks.
     */
    const persistedClientIds = new Set(
      dbMessages
        .map((m) => m.client_message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )

    const streamNotYetInDb = streamAsDisplay.filter((m) => !persistedClientIds.has(m.id))

    return [...dbRendered, ...streamNotYetInDb]
  }, [dbMessages, streamMessages, isStreamActive])

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

          {displayMessages.map((msg, i) => {
            const isLast = i === displayMessages.length - 1
            return (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                metadata={msg.metadata}
                flowStates={flowStates}
                onApproveFlow={handleApproveFlow}
                onRejectFlow={handleRejectFlow}
                isStreaming={isLast && msg.isStreaming && isProcessing}
              />
            )
          })}

          {isProcessing && thinkingStart != null && (displayMessages.length === 0 || displayMessages[displayMessages.length - 1]?.role === 'user') && (
            <ThinkingIndicator startedAt={thinkingStart} />
          )}
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
          <form
            onSubmit={handleSubmit}
            className="relative rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-foreground/25"
          >
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Verona…"
              rows={1}
              className="resize-none border-0 bg-transparent min-h-[56px] max-h-[200px] pl-4 pr-14 py-4 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60"
              disabled={isProcessing}
            />
            <Button
              type="submit"
              size="icon"
              disabled={isProcessing || !input.trim()}
              className="absolute bottom-2.5 right-2.5 size-8 rounded-full"
              aria-label={isProcessing ? 'Sending' : 'Send message'}
            >
              {isProcessing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
