'use client'

import { useState } from 'react'
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react'

export interface FlowStep {
  order: number
  instruction: string
  type: 'navigate' | 'action' | 'assertion' | 'extract' | 'wait'
  url?: string
  expected?: string
  timeout?: number
}

export interface ProposedFlow {
  id: string
  name: string
  description: string
  rationale: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  steps: FlowStep[]
}

interface FlowProposalCardProps {
  flow: ProposedFlow
  state: 'pending' | 'approved' | 'rejected'
  onApprove: (flowId: string) => void
  onReject: (flowId: string) => void
  disabled?: boolean
}

const priorityStyles: Record<string, string> = {
  critical: 'text-red-500',
  high: 'text-orange-500',
  medium: 'text-yellow-500',
  low: 'text-green-500',
}

export function FlowProposalCard({
  flow,
  state,
  onApprove,
  onReject,
  disabled,
}: FlowProposalCardProps) {
  const [expanded, setExpanded] = useState(false)

  const borderClass =
    state === 'approved'
      ? 'border-green-500/40'
      : state === 'rejected'
        ? 'border-red-500/20 opacity-50'
        : 'border-border'

  return (
    <div className={`border rounded-lg p-4 transition-all ${borderClass}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h4 className="text-lg font-medium truncate">{flow.name}</h4>
            <span className={`text-sm ${priorityStyles[flow.priority]}`}>
              {flow.priority}
            </span>
            {state !== 'pending' && (
              <span
                className={`text-sm px-2 py-0.5 rounded-full ${
                  state === 'approved'
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-red-500/10 text-red-500'
                }`}
              >
                {state}
              </span>
            )}
          </div>
          <p className="text-base opacity-60 mt-1">{flow.description}</p>
          <p className="text-sm opacity-40 mt-1 italic">{flow.rationale}</p>
        </div>

        {state === 'pending' && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onApprove(flow.id)}
              disabled={disabled}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-green-500/30 rounded hover:bg-green-500/10 transition-colors disabled:opacity-30"
              title="Approve"
            >
              <Check className="w-4 h-4 text-green-500" />
              <span>Approve</span>
            </button>
            <button
              onClick={() => onReject(flow.id)}
              disabled={disabled}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-red-500/30 rounded hover:bg-red-500/10 transition-colors disabled:opacity-30"
              title="Reject"
            >
              <X className="w-4 h-4 text-red-500" />
              <span>Reject</span>
            </button>
          </div>
        )}
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 mt-3 text-sm opacity-50 hover:opacity-80 transition-opacity"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        {flow.steps.length} steps
      </button>

      {expanded && (
        <ol className="mt-3 space-y-2 pl-4 border-l border-border">
          {flow.steps.map((step) => (
            <li key={step.order} className="text-sm">
              <span className="opacity-40 mr-2">{step.order}.</span>
              <span
                className={`inline-block px-1.5 py-0.5 text-xs rounded mr-2 ${
                  step.type === 'navigate'
                    ? 'bg-blue-500/10 text-blue-500'
                    : step.type === 'assertion'
                      ? 'bg-purple-500/10 text-purple-500'
                      : step.type === 'action'
                        ? 'bg-yellow-500/10 text-yellow-500'
                        : step.type === 'extract'
                          ? 'bg-cyan-500/10 text-cyan-500'
                          : 'bg-muted text-muted-foreground'
                }`}
              >
                {step.type}
              </span>
              <span className="opacity-80">{step.instruction}</span>
              {step.url && (
                <span className="text-xs opacity-40 ml-2">{step.url}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
