'use client'

import { useState } from 'react'
import { Check, X, ChevronDown, ChevronRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'

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

const priorityVariant: Record<string, string> = {
  critical: 'border-red-500/30 text-red-600',
  high: 'border-border text-foreground/70',
  medium: 'border-border text-foreground/70',
  low: 'border-border text-muted-foreground',
}

export function FlowProposalCard({
  flow,
  state,
  onApprove,
  onReject,
  disabled,
}: FlowProposalCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card
      size="sm"
      className={`ring-0 border border-border bg-card transition-all ${
        state === 'approved'
          ? 'ring-1 ring-inset ring-green-500/30'
          : state === 'rejected'
            ? 'opacity-60'
            : ''
      }`}
    >
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-[15px] font-medium truncate">{flow.name}</h4>
              <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${priorityVariant[flow.priority]}`}>
                {flow.priority}
              </Badge>
              {state !== 'pending' && (
                <Badge
                  variant="outline"
                  className={`text-[10px] uppercase tracking-wide ${state === 'approved' ? 'border-green-500/30 text-green-600' : 'border-border text-muted-foreground'}`}
                >
                  {state}
                </Badge>
              )}
            </div>
            <p className="text-sm text-foreground/80 mt-1">{flow.description}</p>
            <p className="text-xs text-muted-foreground mt-1 italic">{flow.rationale}</p>
          </div>

          {state === 'pending' && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onApprove(flow.id)}
                disabled={disabled}
                className="border-border hover:border-green-500/40 hover:text-green-700 hover:bg-green-500/5"
              >
                <Check className="size-3.5" />
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReject(flow.id)}
                disabled={disabled}
                className="border-border hover:border-red-500/40 hover:text-red-700 hover:bg-red-500/5"
              >
                <X className="size-3.5" />
                Reject
              </Button>
            </div>
          )}
        </div>

        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger className="flex items-center gap-1 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {flow.steps.length} steps
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-3 space-y-2 pl-4 border-l border-border">
              {flow.steps.map((step) => (
                <li key={step.order} className="text-[13px] font-mono leading-relaxed">
                  <span className="text-muted-foreground/50 mr-2">{step.order}.</span>
                  <span className="text-muted-foreground uppercase tracking-wide text-[10px] mr-2">
                    {step.type}
                  </span>
                  <span className="text-foreground/85">{step.instruction}</span>
                  {step.url && (
                    <span className="text-xs text-muted-foreground/60 ml-2">{step.url}</span>
                  )}
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
