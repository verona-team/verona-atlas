'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useChat } from 'ai/react'
import { Send, Loader2, RefreshCw } from 'lucide-react'
import { MessageBubble } from './message-bubble'
import type { ProposedFlow } from './flow-proposal-card'
import type { Json, ChatMessage } from '@/lib/supabase/types'
import { createClient } from '@/lib/supabase/client'

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
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [flowStates, setFlowStates] = useState<Record<string, 'pending' | 'approved' | 'rejected'>>({})
  const [proposalMessageId, setProposalMessageId] = useState<string | null>(null)
  const [dbMessages, setDbMessages] = useState<ChatMessage[]>(initialMessages)
  const hasInitialized = useRef(false)

  useEffect(() => {
    for (const msg of dbMessages) {
      const meta = msg.metadata as Record<string, Json> | null
      if (meta?.type === 'flow_proposals' && meta.flow_states) {
        setFlowStates(meta.flow_states as Record<string, 'pending' | 'approved' | 'rejected'>)
        setProposalMessageId(msg.id)
      }
    }
  }, [dbMessages])

  const { messages, input, handleInputChange, handleSubmit, isLoading, append } = useChat({
    api: '/api/chat',
    body: { projectId },
    initialMessages: dbMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
  })

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    if (dbMessages.length === 0) {
      append({
        role: 'user',
        content: `I just set up ${projectName} (${appUrl}). Analyze my project data and suggest UI flows to test.`,
      })
    }
  }, [dbMessages.length, projectName, appUrl, append])

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

          const meta = newMsg.metadata as Record<string, Json> | null
          if (meta?.type === 'flow_proposals' && meta.flow_states) {
            setFlowStates(meta.flow_states as Record<string, 'pending' | 'approved' | 'rejected'>)
            setProposalMessageId(newMsg.id)
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

          const meta = updated.metadata as Record<string, Json> | null
          if (meta?.flow_states) {
            setFlowStates(meta.flow_states as Record<string, 'pending' | 'approved' | 'rejected'>)
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, dbMessages])

  const handleApproveFlow = useCallback(
    async (flowId: string) => {
      if (!proposalMessageId) return
      setFlowStates((prev) => ({ ...prev, [flowId]: 'approved' }))

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
      setFlowStates((prev) => ({ ...prev, [flowId]: 'rejected' }))

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim() && !isLoading) {
        handleSubmit(e as unknown as React.FormEvent<HTMLFormElement>)
      }
    }
  }

  const getMetadataForMessage = (messageId: string): Record<string, Json> | undefined => {
    const dbMsg = dbMessages.find((m) => m.id === messageId)
    if (!dbMsg) return undefined
    const meta = dbMsg.metadata as Record<string, Json> | null
    if (meta?.type) return meta
    return undefined
  }

  const allMessages = (() => {
    const dbMsgIds = new Set(dbMessages.map((m) => m.id))
    const streamingMessages = messages.filter((m) => !dbMsgIds.has(m.id))

    const combined = [
      ...dbMessages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          metadata: m.metadata as Record<string, Json> | undefined,
          isDb: true,
        })),
      ...streamingMessages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        metadata: undefined as Record<string, Json> | undefined,
        isDb: false,
      })),
    ]

    return combined
  })()

  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {allMessages.length === 0 && !isLoading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              <h2 className="text-3xl">Welcome to Verona</h2>
              <p className="text-lg opacity-50 max-w-md">
                I&apos;ll analyze your project and suggest UI flows to test.
                Let&apos;s get started.
              </p>
            </div>
          </div>
        )}

        {allMessages.map((msg, i) => {
          const metadata = msg.metadata ?? getMetadataForMessage(msg.id)
          const isLast = i === allMessages.length - 1
          return (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              metadata={metadata}
              flowStates={flowStates}
              onApproveFlow={handleApproveFlow}
              onRejectFlow={handleRejectFlow}
              isStreaming={isLast && isLoading && msg.role === 'assistant'}
            />
          )
        })}

        {isLoading && allMessages[allMessages.length - 1]?.role === 'user' && (
          <div className="flex items-center gap-2 text-sm opacity-50">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Verona is thinking...</span>
          </div>
        )}
      </div>

      {approvedCount > 0 && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 text-sm opacity-60 bg-green-500/5 border border-green-500/20 rounded-lg px-3 py-2">
            <span>{approvedCount} flow{approvedCount !== 1 ? 's' : ''} approved</span>
            <span className="opacity-40">·</span>
            <span>Tell me to &quot;start testing&quot; when ready</span>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="border-t px-4 py-4"
      >
        <div className="flex items-end gap-3 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Give feedback on the test flows, or say 'start testing' to begin..."
            rows={1}
            className="flex-1 resize-none bg-transparent border rounded-lg px-4 py-3 text-base outline-none placeholder:opacity-30 focus:border-foreground/30 transition-colors"
            style={{ minHeight: '48px', maxHeight: '160px' }}
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="p-3 rounded-lg border transition-all hover:bg-foreground/5 disabled:opacity-20"
          >
            {isLoading ? (
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
