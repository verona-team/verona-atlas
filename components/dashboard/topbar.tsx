'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Settings, ExternalLink } from 'lucide-react'
import { useWorkspace } from '@/lib/workspace-context'
import { SidebarToggle } from '@/components/dashboard/sidebar'
import { Button } from '@/components/ui/button'

export function AppHeader() {
  const { projects, activeProjectId } = useWorkspace()
  const pathname = usePathname()

  const activeProject = projects.find((p) => p.id === activeProjectId)

  const isSettingsActive =
    activeProjectId && pathname.includes(`/projects/${activeProjectId}/settings`)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <SidebarToggle />

      {activeProject ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium leading-tight">
              {activeProject.name}
            </h1>
          </div>
          <a
            href={activeProject.app_url}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="truncate max-w-[200px]">
              {activeProject.app_url.replace(/^https?:\/\//, '')}
            </span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {activeProjectId && (
        <nav className="flex items-center gap-1">
          <Button
            variant={isSettingsActive ? 'secondary' : 'ghost'}
            size="sm"
            render={<Link href={`/projects/${activeProjectId}/settings`} prefetch />}
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Settings</span>
          </Button>
        </nav>
      )}
    </header>
  )
}
