'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface TestRunStatus {
  status: string
  summary: Record<string, unknown> | null
  started_at: string | null
  completed_at: string | null
}

export function useTestRunStatus(runId: string | null) {
  const [data, setData] = useState<TestRunStatus | null>(null)

  useEffect(() => {
    if (!runId) return

    const supabase = createClient()

    const channel = supabase
      .channel(`run-status-${runId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'test_runs',
          filter: `id=eq.${runId}`,
        },
        (payload) => {
          const newRun = payload.new as Record<string, unknown>
          setData({
            status: newRun.status as string,
            summary: newRun.summary as Record<string, unknown> | null,
            started_at: newRun.started_at as string | null,
            completed_at: newRun.completed_at as string | null,
          })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [runId])

  return data
}
