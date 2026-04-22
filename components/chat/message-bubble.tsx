'use client'

import type { ProposedFlow } from './flow-proposal-card'
import { FlowProposalCard } from './flow-proposal-card'
import { MarkdownContent } from './markdown-content'
import type { Json } from '@/lib/supabase/types'

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, Json>
  flowStates?: Record<string, 'pending' | 'approved' | 'rejected'>
  onApproveFlow?: (flowId: string) => void
  onRejectFlow?: (flowId: string) => void
  isStreaming?: boolean
}

export function MessageBubble({
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
      {!isFlowProposal && !isRunStarted && (
        <div className="text-[15px] leading-[1.7] text-foreground">
          <MarkdownContent content={content} />
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-foreground/60 animate-pulse" />
          )}
        </div>
      )}

      {isFlowProposal && proposals && (
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
                onApprove={onApproveFlow ?? (() => {})}
                onReject={onRejectFlow ?? (() => {})}
              />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Approve or reject each flow, then tell me to start testing when you&apos;re ready.
          </p>
        </div>
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
