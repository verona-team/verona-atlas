'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const statusConfig = {
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  planning: { label: 'Planning', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
  running: { label: 'Running', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
} as const

interface RunStatusBadgeProps {
  status: string
}

export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending

  return (
    <Badge variant="secondary" className={cn('text-xs font-medium', config.className)}>
      {config.label}
    </Badge>
  )
}
