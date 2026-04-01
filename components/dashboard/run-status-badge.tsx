'use client'

const statusConfig = {
  pending: { label: 'pending', color: 'opacity-40' },
  planning: { label: 'planning', color: 'text-blue-700' },
  running: { label: 'running', color: 'text-amber-700' },
  completed: { label: 'done', color: 'text-green-700' },
  failed: { label: 'failed', color: 'text-red-700' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending
  return <span className={`text-xs ${config.color}`}>{config.label}</span>
}
