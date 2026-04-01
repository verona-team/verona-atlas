'use client'

const statusConfig = {
  pending: { label: 'PENDING', color: 'text-phosphor-dim' },
  planning: { label: 'PLANNING', color: 'text-[#3388ff]' },
  running: { label: 'RUNNING', color: 'text-[#ffaa00]' },
  completed: { label: 'DONE', color: 'text-[#33ff33]' },
  failed: { label: 'FAILED', color: 'text-destructive' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending

  return (
    <span className={`text-[10px] uppercase tracking-wider font-bold ${config.color}`}>
      {config.label}
    </span>
  )
}
