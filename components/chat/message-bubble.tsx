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

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] ${
          isUser
            ? 'bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-6 py-4'
            : 'space-y-5'
        }`}
      >
        {isUser ? (
          <p className="text-lg whitespace-pre-wrap">{content}</p>
        ) : (
          <>
            {!isFlowProposal && !isRunStarted && (
              <div className="text-base opacity-90">
                <MarkdownContent content={content} />
                {isStreaming && (
                  <span className="inline-block w-2 h-5 ml-1 bg-foreground/60 animate-pulse" />
                )}
              </div>
            )}

            {isFlowProposal && proposals && (
              <div className="space-y-5">
                <p className="text-lg opacity-80 leading-relaxed">
                  {proposals.analysis}
                </p>
                <p className="text-lg opacity-60">
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
                <p className="text-base opacity-50">
                  Approve or reject each flow, then tell me to start testing when you&apos;re ready.
                </p>
              </div>
            )}

            {isRunStarted && (
              <div className="flex items-center gap-3 border border-green-500/20 rounded-lg p-5 bg-green-500/5">
                <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                <p className="text-lg">{content}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
