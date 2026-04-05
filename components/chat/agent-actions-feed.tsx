'use client'

import { useState, useEffect, useRef } from 'react'
import {
  GitBranch,
  BarChart3,
  Bug,
  Brain,
  FlaskConical,
  Code2,
  Settings2,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import type { AgentActionData, AgentActionIntegration } from '@/lib/chat/agent-actions'

const INTEGRATION_META: Record<
  AgentActionIntegration,
  { label: string; icon: typeof GitBranch; color: string }
> = {
  github: { label: 'GitHub', icon: GitBranch, color: 'text-[#8b5cf6]' },
  posthog: { label: 'PostHog', icon: BarChart3, color: 'text-[#f59e0b]' },
  sentry: { label: 'Sentry', icon: Bug, color: 'text-[#e11d48]' },
  langsmith: { label: 'LangSmith', icon: Brain, color: 'text-[#06b6d4]' },
  braintrust: { label: 'Braintrust', icon: FlaskConical, color: 'text-[#22c55e]' },
  codebase: { label: 'Codebase', icon: Code2, color: 'text-[#3b82f6]' },
  system: { label: 'System', icon: Settings2, color: 'text-muted-foreground' },
}

function StatusIcon({ status }: { status: AgentActionData['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    case 'complete':
      return <Check className="h-3.5 w-3.5 text-green-500" />
    case 'error':
      return <X className="h-3.5 w-3.5 text-red-500" />
  }
}

function ActionRow({ action }: { action: AgentActionData }) {
  const meta = INTEGRATION_META[action.integration] ?? INTEGRATION_META.system
  const Icon = meta.icon

  return (
    <div className="group flex items-start gap-2.5 py-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <StatusIcon status={action.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.color}`} />
          <span className="truncate text-sm font-medium">{action.label}</span>
        </div>
        {action.detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/70">
            {action.detail}
          </p>
        )}
      </div>
      <ElapsedBadge action={action} />
    </div>
  )
}

function computeElapsed(action: AgentActionData): number {
  if (action.status !== 'running' && action.completedAt && action.startedAt) {
    return Math.round((action.completedAt - action.startedAt) / 1000)
  }
  if (action.status === 'running' && action.startedAt) {
    return Math.round((Date.now() - action.startedAt) / 1000)
  }
  return 0
}

function ElapsedBadge({ action }: { action: AgentActionData }) {
  const [elapsed, setElapsed] = useState(() => computeElapsed(action))
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (action.status !== 'running' || !action.startedAt) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    const start = action.startedAt
    intervalRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - start) / 1000))
    }, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [action.status, action.startedAt])

  const displayElapsed = action.status !== 'running' ? computeElapsed(action) : elapsed

  if (displayElapsed === 0 && action.status === 'running') return null

  return (
    <span className="shrink-0 tabular-nums text-xs text-muted-foreground/50">
      {displayElapsed}s
    </span>
  )
}

interface AgentActionsFeedProps {
  actions: AgentActionData[]
}

export function AgentActionsFeed({ actions }: AgentActionsFeedProps) {
  const [expanded, setExpanded] = useState(true)
  const runningCount = actions.filter((a) => a.status === 'running').length
  const completeCount = actions.filter((a) => a.status === 'complete').length
  const errorCount = actions.filter((a) => a.status === 'error').length

  if (actions.length === 0) return null

  const allDone = runningCount === 0

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden transition-all">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
      >
        {!allDone ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
        ) : errorCount > 0 ? (
          <X className="h-4 w-4 shrink-0 text-red-500" />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-green-500" />
        )}
        <span className="flex-1 text-sm font-medium">
          {!allDone
            ? `Researching your project\u2026`
            : errorCount > 0
              ? `Research complete with ${errorCount} error${errorCount !== 1 ? 's' : ''}`
              : `Research complete`}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
          {completeCount + errorCount}/{actions.length}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/30 px-4 py-2">
          {actions.map((action) => (
            <ActionRow key={action.actionId} action={action} />
          ))}
        </div>
      )}
    </div>
  )
}
