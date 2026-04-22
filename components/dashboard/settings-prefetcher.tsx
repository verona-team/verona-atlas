'use client'

import { useEffect } from 'react'
import { prefetchSettings } from '@/lib/settings-prefetch'

/**
 * Fire-and-forget prefetcher that warms the settings overlay cache while the
 * user is in the chat. The click on the "Settings" button can then render the
 * panel with data already in hand, instead of waiting for a cold fetch.
 */
export function SettingsPrefetcher({ projectId }: { projectId: string }) {
  useEffect(() => {
    void prefetchSettings(projectId)
  }, [projectId])
  return null
}
