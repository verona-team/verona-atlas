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
  critical: 'border-red-500/30 text-red-500',
  high: 'border-orange-500/30 text-orange-500',
  medium: 'border-yellow-500/30 text-yellow-500',
  low: 'border-green-500/30 text-green-500',
}

const stepTypeStyle: Record<string, string> = {
  navigate: 'border-blue-500/30 text-blue-500',
  assertion: 'border-purple-500/30 text-purple-500',
  action: 'border-yellow-500/30 text-yellow-500',
  extract: 'border-cyan-500/30 text-cyan-500',
  wait: '',
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
      className={`ring-0 border transition-all ${
        state === 'approved'
          ? 'border-green-500/40'
          : state === 'rejected'
            ? 'border-red-500/20 opacity-50'
            : 'border-border'
      }`}
    >
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-base font-medium truncate">{flow.name}</h4>
              <Badge variant="outline" className={priorityVariant[flow.priority]}>
                {flow.priority}
              </Badge>
              {state !== 'pending' && (
                <Badge
                  variant={state === 'approved' ? 'outline' : 'destructive'}
                  className={state === 'approved' ? 'border-green-500/30 text-green-500' : ''}
                >
                  {state}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">{flow.description}</p>
            <p className="text-xs text-muted-foreground/70 mt-1 italic">{flow.rationale}</p>
          </div>

          {state === 'pending' && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onApprove(flow.id)}
                disabled={disabled}
                className="border-green-500/30 text-green-600 hover:bg-green-500/10"
              >
                <Check className="size-3.5" />
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onReject(flow.id)}
                disabled={disabled}
                className="border-red-500/30 text-red-600 hover:bg-red-500/10"
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
                <li key={step.order} className="text-sm">
                  <span className="text-muted-foreground/50 mr-2">{step.order}.</span>
                  <Badge variant="outline" className={`text-[10px] mr-2 ${stepTypeStyle[step.type] || ''}`}>
                    {step.type}
                  </Badge>
                  <span className="text-foreground/80">{step.instruction}</span>
                  {step.url && (
                    <span className="text-xs text-muted-foreground/50 ml-2">{step.url}</span>
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
