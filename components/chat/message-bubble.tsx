'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ProposedFlow } from './flow-proposal-card'
import { FlowProposalCard } from './flow-proposal-card'
import { LiveSessionCard } from './live-session-card'
import { MarkdownContent } from './markdown-content'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Json } from '@/lib/supabase/types'

interface MessageBubbleProps {
  projectId: string
  /**
   * The chat_messages row id for this bubble. Required on flow_proposals
   * bubbles so per-card approve/reject clicks can PATCH against the
   * specific proposals row they belong to (multiple proposals rows can
   * coexist — one active, zero or more superseded).
   */
  messageId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, Json>
  flowStates?: Record<string, 'pending' | 'approved' | 'rejected'>
  onApproveFlow?: (messageId: string, flowId: string) => void
  onRejectFlow?: (messageId: string, flowId: string) => void
  isStreaming?: boolean
}

export function MessageBubble({
  projectId,
  messageId,
  role,
  content,
  metadata,
  flowStates,
  onApproveFlow,
  onRejectFlow,
  isStreaming,
}: MessageBubbleProps) {
  const isUser = role === 'user'
  const isFlowProposal = metadata?.type === 'flow_proposals'
  const isRunStarted = metadata?.type === 'test_run_started'
  const isLiveSession = metadata?.type === 'live_session'
  const isSuperseded =
    isFlowProposal && (metadata?.status as string | undefined) === 'superseded'

  const proposals = isFlowProposal
    ? (metadata.proposals as unknown as { analysis: string; flows: ProposedFlow[] })
    : null

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4">
      {!isFlowProposal && !isRunStarted && !isLiveSession && (
        <div className="text-[15px] leading-[1.7] text-foreground">
          <MarkdownContent content={content} />
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-foreground/60 animate-pulse" />
          )}
        </div>
      )}

      {isLiveSession && metadata && (
        <LiveSessionCard projectId={projectId} metadata={metadata} />
      )}

      {isFlowProposal && proposals && (
        <SupersedableProposals
          messageId={messageId}
          proposals={proposals}
          flowStates={flowStates}
          superseded={isSuperseded}
          onApproveFlow={onApproveFlow}
          onRejectFlow={onRejectFlow}
        />
      )}

      {isRunStarted && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-foreground/[0.03] px-4 py-3">
          <div className="size-2 rounded-full bg-green-500 animate-pulse" />
          <p className="text-sm text-foreground">{content}</p>
        </div>
      )}
    </div>
  )
}

interface SupersedableProposalsProps {
  messageId: string
  proposals: { analysis: string; flows: ProposedFlow[] }
  flowStates?: Record<string, 'pending' | 'approved' | 'rejected'>
  superseded: boolean
  onApproveFlow?: (messageId: string, flowId: string) => void
  onRejectFlow?: (messageId: string, flowId: string) => void
}

/**
 * Renders a proposals card stack. For active rows: inline, fully interactive.
 * For superseded rows: collapsed behind a disclosure header, cards are
 * read-only (no Approve/Reject). The superseded branch is what lets a user
 * ask the agent to regenerate flows without their old cards remaining in
 * the approvable surface.
 */
function SupersedableProposals({
  messageId,
  proposals,
  flowStates,
  superseded,
  onApproveFlow,
  onRejectFlow,
}: SupersedableProposalsProps) {
  const [expanded, setExpanded] = useState(false)

  const handleApprove = onApproveFlow
    ? (flowId: string) => onApproveFlow(messageId, flowId)
    : () => {}
  const handleReject = onRejectFlow
    ? (flowId: string) => onRejectFlow(messageId, flowId)
    : () => {}

  if (superseded) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-foreground/[0.02]">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="w-full justify-start gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="flex-1 text-left">
            {proposals.flows.length} earlier flow suggestion
            {proposals.flows.length === 1 ? '' : 's'} — replaced below
          </span>
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide border-border text-muted-foreground"
          >
            replaced
          </Badge>
        </Button>
        {expanded && (
          <div className="px-3 pb-3 space-y-3 opacity-70">
            <p className="text-sm text-muted-foreground">{proposals.analysis}</p>
            <div className="space-y-3">
              {proposals.flows.map((flow) => (
                <FlowProposalCard
                  key={flow.id}
                  flow={flow}
                  state={flowStates?.[flow.id] ?? 'pending'}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  readonly
                />
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[15px] leading-[1.7] text-foreground">
        {proposals.analysis}
      </p>
      <p className="text-sm text-muted-foreground">
        Here are the UI flows I recommend testing:
      </p>
      <div className="space-y-3">
        {proposals.flows.map((flow) => (
          <FlowProposalCard
            key={flow.id}
            flow={flow}
            state={flowStates?.[flow.id] ?? 'pending'}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Approve or reject each flow, then tell me to start testing when you&apos;re ready.
      </p>
    </div>
  )
}
