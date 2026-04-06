'use client'

const statusConfig = {
  pending: { label: 'pending', color: 'text-muted-foreground' },
  planning: { label: 'planning', color: 'text-blue-600' },
  running: { label: 'running', color: 'text-amber-600' },
  completed: { label: 'done', color: 'text-green-600' },
  failed: { label: 'failed', color: 'text-red-600' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending
  return <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
}
