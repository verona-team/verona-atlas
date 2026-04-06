'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Play, Loader2 } from 'lucide-react'

interface TriggerRunButtonProps {
  projectId: string
  variant?: 'header' | 'page'
}

export function TriggerRunButton({ projectId, variant = 'header' }: TriggerRunButtonProps) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleTrigger() {
    setLoading(true)
    try {
      const response = await fetch('/api/runs/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      const data = await response.json()
      if (!response.ok) { toast.error(data.error || 'Failed to trigger test run'); return }
      toast.success('Test run triggered')
      router.push(`/projects/${projectId}/runs/${data.id}`)
      router.refresh()
    } catch { toast.error('Failed to trigger test run') } finally { setLoading(false) }
  }

  if (variant === 'page') {
    return (
      <button onClick={handleTrigger} disabled={loading} className="text-2xl underline disabled:opacity-30">
        {loading ? 'Running...' : 'Run Tests'}
      </button>
    )
  }

  return (
    <button
      onClick={handleTrigger}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-30"
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Play className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">{loading ? 'Running...' : 'Run'}</span>
    </button>
  )
}
