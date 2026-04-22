'use client'

import { useEffect, useState } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsContent } from '@/components/dashboard/settings-content'
import { useWorkspace } from '@/lib/workspace-context'
import { cn } from '@/lib/utils'

/**
 * Overlay settings panel driven by `workspace-context`. Intentionally does NOT
 * change the route: opening settings over the chat must not unmount the chat.
 */
export function SettingsPanel() {
  const { settingsProjectId, closeSettings } = useWorkspace()
  // `renderProjectId` lingers through the slide-out animation so
  // <SettingsContent /> doesn't unmount/refetch while the panel is closing.
  const [renderProjectId, setRenderProjectId] = useState<string | null>(
    settingsProjectId,
  )
  if (settingsProjectId && settingsProjectId !== renderProjectId) {
    setRenderProjectId(settingsProjectId)
  }
  const visible = !!settingsProjectId

  useEffect(() => {
    if (settingsProjectId) return
    const timer = window.setTimeout(() => setRenderProjectId(null), 200)
    return () => window.clearTimeout(timer)
  }, [settingsProjectId])

  useEffect(() => {
    if (!settingsProjectId) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Don't close the panel if an AlertDialog (or other dialog) is open
        if (document.querySelector('[data-slot="alert-dialog-overlay"]')) return
        e.preventDefault()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsProjectId, closeSettings])

  if (!renderProjectId) return null

  return (
    <>
      <div
        aria-hidden
        onClick={closeSettings}
        className={cn(
          'fixed inset-0 z-40 transition-opacity duration-200',
          visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />
      <aside
        role="dialog"
        aria-label="Project settings"
        data-open={visible ? '' : undefined}
        data-closed={visible ? undefined : ''}
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full sm:max-w-2xl bg-popover text-popover-foreground border-l border-border shadow-lg overflow-y-auto',
          'data-open:animate-in data-open:slide-in-from-right data-open:duration-200',
          'data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200',
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <h2 className="font-heading text-base font-medium text-foreground">Settings</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={closeSettings}
            aria-label="Close settings"
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 pb-8">
          {/*
           * `key` remounts SettingsContent when the active project changes
           * while the panel is open. Without it, React reuses the instance
           * and stale `project` / `integrations` state from the previous
           * project survives until the new fetch resolves — which creates
           * a confirmable-delete race in <DeleteProjectSection> where
           * `projectName` and `projectId` briefly point at different
           * projects.
           */}
          <SettingsContent key={renderProjectId} projectId={renderProjectId} />
        </div>
      </aside>
    </>
  )
}
