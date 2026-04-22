'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * When the URL has `?settings=1`, open the settings overlay for the given
 * project and strip the query param so the URL stays clean without navigating
 * away from the chat.
 */
export function SettingsQueryOpener({ projectId }: { projectId: string }) {
  const { openSettings } = useWorkspace()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    if (searchParams.get('settings') !== '1') return
    openSettings(projectId)
    const remaining = new URLSearchParams(searchParams.toString())
    remaining.delete('settings')
    const query = remaining.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [searchParams, pathname, router, projectId, openSettings])

  return null
}
