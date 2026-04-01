'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface TriggerRunButtonProps {
  projectId: string
}

export function TriggerRunButton({ projectId }: TriggerRunButtonProps) {
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

      if (!response.ok) {
        toast.error(data.error || 'Failed to trigger test run')
        return
      }

      toast.success('Test run triggered successfully!')
      router.push(`/projects/${projectId}/runs/${data.id}`)
      router.refresh()
    } catch {
      toast.error('Failed to trigger test run')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleTrigger}
      disabled={loading}
      className="text-xs uppercase tracking-wider border border-foreground bg-foreground text-background px-3 py-1.5 hover:bg-phosphor-bright disabled:opacity-50 transition-colors"
    >
      {loading ? '...' : '▶ Run Tests'}
    </button>
  )
}
