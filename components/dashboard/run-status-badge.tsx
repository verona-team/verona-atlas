'use client'

import { Badge } from '@/components/ui/badge'

const statusConfig = {
  pending: { label: 'pending', className: '' },
  planning: { label: 'planning', className: 'border-blue-500/30 text-blue-600' },
  running: { label: 'running', className: 'border-amber-500/30 text-amber-600' },
  completed: { label: 'done', className: 'border-green-500/30 text-green-600' },
  failed: { label: 'failed', className: 'border-red-500/30 text-red-600' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending
  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  )
}
