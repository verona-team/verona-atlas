'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsContent } from '@/components/dashboard/settings-content'
import { cn } from '@/lib/utils'

interface SettingsPanelProps {
  projectId: string
}

export function SettingsPanel({ projectId }: SettingsPanelProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    // `router.back()` closes the intercepted modal instantly without
    // re-mounting the chat. For the rarer direct-URL case, `replace` is
    // the clean fallback that still lands the user back in the chat.
    window.setTimeout(() => {
      try {
        if (window.history.length > 1) {
          router.back()
          return
        }
      } catch {}
      router.replace(`/projects/${projectId}/chat`)
    }, 180)
  }, [router, projectId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  return (
    <>
      <div
        aria-hidden
        className={cn(
          'fixed inset-0 z-40 transition-opacity duration-200',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={handleClose}
      />
      <aside
        role="dialog"
        aria-label="Project settings"
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full sm:max-w-2xl bg-popover text-popover-foreground border-l border-border shadow-lg overflow-y-auto transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <h2 className="font-heading text-base font-medium text-foreground">Settings</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClose}
            aria-label="Close settings"
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 pb-8">
          <SettingsContent projectId={projectId} />
        </div>
      </aside>
    </>
  )
}
