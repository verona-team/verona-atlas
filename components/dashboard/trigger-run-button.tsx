'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Play, Loader2 } from 'lucide-react'
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
    } catch (error) {
      toast.error('Failed to trigger test run')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button onClick={handleTrigger} disabled={loading}>
      {loading ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Play className="mr-2 h-4 w-4" />
      )}
      Run Tests
    </Button>
  )
}
