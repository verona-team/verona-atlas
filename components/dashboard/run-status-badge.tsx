'use client'

const statusConfig = {
  pending: { label: 'pending', color: 'text-muted-foreground' },
  planning: { label: 'planning', color: 'text-blue-400' },
  running: { label: 'running', color: 'text-amber-400' },
  completed: { label: 'done', color: 'text-green-400' },
  failed: { label: 'failed', color: 'text-red-400' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending
  return <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
}
