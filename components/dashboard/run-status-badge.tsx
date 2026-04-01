'use client'

const statusConfig = {
  pending: { label: 'PENDING', color: 'text-[#6b6555]' },
  planning: { label: 'PLANNING', color: 'text-[#2a5aaa]' },
  running: { label: 'RUNNING', color: 'text-[#b07d10]' },
  completed: { label: 'DONE', color: 'text-[#2a7a2a]' },
  failed: { label: 'FAILED', color: 'text-[#c43333]' },
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
