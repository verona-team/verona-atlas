'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Opens the settings overlay for `projectId` on mount. Also strips a
 * `?settings=1` query param from the URL when present (from OAuth callbacks
 * or deep links), via `router.replace` so the chat page is not re-navigated.
 *
 * This runs purely on the client; the parent server component must NOT redirect
 * based on the `settings` param, or we'd loop: strip → server rerender → redirect.
 */
export function SettingsQueryOpener({ projectId }: { projectId: string }) {
  const { openSettings } = useWorkspace()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    openSettings(projectId)

    if (searchParams.get('settings') === '1') {
      const remaining = new URLSearchParams(searchParams.toString())
      remaining.delete('settings')
      const query = remaining.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
  }, [searchParams, pathname, router, projectId, openSettings])

  return null
}
