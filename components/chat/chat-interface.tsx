'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { MessageBubble } from './message-bubble'
import type { Json, ChatMessage } from '@/lib/supabase/types'
import { createClient } from '@/lib/supabase/client'

function getTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
}

/**
 * Assistant turns are often tool-only (no `text` parts): the model calls
 * `generate_flow_proposals` and streams no prose. Surface tool output until
 * the DB row (with flow cards) arrives.
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
  if (role !== 'assistant') {
    return getTextFromParts(parts)
  }
  const plain = getTextFromParts(parts)
  if (plain.length > 0) return plain

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
        if (typeof o.analysis === 'string' && o.analysis.length > 0) {
          return o.analysis
        }
        if (o.success === true && typeof o.flowCount === 'number') {
          return `Prepared ${o.flowCount} test flow proposal(s) for you.`
        }
      }
    }
  }
  return ''
}

interface ChatInterfaceProps {
  projectId: string
  sessionId: string
  initialMessages: ChatMessage[]
  projectName: string
  appUrl: string
}

export function ChatInterface({
  projectId,
  sessionId,
  initialMessages,
  projectName,
  appUrl,
}: ChatInterfaceProps) {
  const router = useRouter()
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const [flowStatesOverride, setFlowStatesOverride] = useState<Record<string, 'pending' | 'approved' | 'rejected'> | null>(null)
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>(initialMessages)
  /** Bumps on bootstrap failure so we retry auto-send (see onError). */
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const lastBootstrapKeyRef = useRef<string | null>(null)
  const bootstrapFailureCountRef = useRef(0)
  const dbEmptyRef = useRef(initialMessages.length === 0)

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
            router.push(`/projects/${projectId}/setup`)
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

    const key = `${sessionId}:${bootstrapNonce}`
    if (lastBootstrapKeyRef.current === key) return
    lastBootstrapKeyRef.current = key

    void sendMessage({
      text: `I just set up ${projectName} (${appUrl}). Analyze my project data and suggest UI flows to test.`,
    })
  }, [
    dbMessages.length,
    bootstrapNonce,
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
            return [...prev, newMsg]
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
            prev.map((m) => (m.id === updated.id ? updated : m)),
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

  // Realtime can miss events (tab backgrounded, reconnect gaps). Re-fetch after a response completes.
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
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [streamMessages, dbMessages])

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (input.trim() && status === 'ready') {
      sendMessage({ text: input })
      setInput('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim() && status === 'ready') {
        sendMessage({ text: input })
        setInput('')
      }
    }
  }

  const displayMessages = useMemo(() => {
    const dbRendered = dbMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        metadata: m.metadata as Record<string, Json> | undefined,
        isStreaming: false,
      }))

    const isStreamActive = status === 'submitted' || status === 'streaming'

    // Match DB rows by role + content prefix (UI message ids differ from DB UUIDs).
    const dbContentSet = new Set(
      dbMessages.map((m) => `${m.role}:${m.content.slice(0, 100)}`),
    )

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
          // Only the last bubble uses this (see MessageBubble); mirror prior behavior.
          isStreaming: isStreamActive && m.role === 'assistant',
        }
      })
      .filter((m) => m.content.length > 0)

    const streamNotYetInDb = streamAsDisplay.filter((m) => {
      const key = `${m.role}:${m.content.slice(0, 100)}`
      return !dbContentSet.has(key)
    })

    if (isStreamActive) {
      return [...dbRendered, ...streamNotYetInDb]
    }

    // After the stream ends, Supabase realtime can lag briefly behind `ready`.
    // Keep showing stream copy until the same content appears in `dbMessages`.
    if (streamNotYetInDb.length > 0) {
      return [...dbRendered, ...streamNotYetInDb]
    }

    return dbRendered
  }, [dbMessages, streamMessages, status])

  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length
  const isProcessing = status === 'submitted' || status === 'streaming'

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {displayMessages.length === 0 && !isProcessing && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              <h2 className="text-4xl">Welcome to Verona</h2>
              <p className="text-xl opacity-50 max-w-md">
                I&apos;ll analyze your project and suggest UI flows to test.
                Let&apos;s get started.
              </p>
            </div>
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

        {isProcessing && (displayMessages.length === 0 || displayMessages[displayMessages.length - 1]?.role === 'user') && (
          <div className="flex items-center gap-3 text-base opacity-50">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Verona is thinking...</span>
          </div>
        )}
      </div>

      {approvedCount > 0 && (
        <div className="px-4 pb-2 shrink-0">
          <div className="flex items-center gap-2 text-base opacity-60 bg-green-500/5 border border-green-500/20 rounded-lg px-4 py-2.5">
            <span>{approvedCount} flow{approvedCount !== 1 ? 's' : ''} approved</span>
            <span className="opacity-40">·</span>
            <span>Tell me to &quot;start testing&quot; when ready</span>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t px-4 py-4 shrink-0">
        <div className="flex items-end gap-3 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Give feedback on the test flows, or say 'start testing' to begin..."
            rows={1}
            className="flex-1 resize-none bg-transparent border rounded-lg px-4 py-3 text-lg outline-none placeholder:opacity-30 focus:border-foreground/30 transition-colors"
            style={{ minHeight: '52px', maxHeight: '160px' }}
            disabled={isProcessing}
          />
          <button
            type="submit"
            disabled={isProcessing || !input.trim()}
            className="p-3 rounded-lg border transition-all hover:bg-foreground/5 disabled:opacity-20"
          >
            {isProcessing ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
