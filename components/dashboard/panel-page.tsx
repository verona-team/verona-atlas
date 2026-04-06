'use client'

import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PanelPageProps {
  projectId: string
  title: string
  children: React.ReactNode
  className?: string
}

export function PanelPage({ projectId, title, children, className }: PanelPageProps) {
  const router = useRouter()

  function handleClose() {
    router.push(`/projects/${projectId}`)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30"
        onClick={handleClose}
      />

      {/* Slide-over panel */}
      <div
        className={cn(
          'relative z-10 flex h-full w-full max-w-2xl flex-col bg-background border-l border-border shadow-2xl animate-in slide-in-from-right duration-200',
          className,
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
          <h2 className="text-sm font-medium">{title}</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>
  )
}
