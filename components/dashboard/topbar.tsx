'use client'

import { usePathname } from 'next/navigation'
import { History, Settings, ExternalLink } from 'lucide-react'
import { useWorkspace } from '@/lib/workspace-context'
import { SidebarToggle } from '@/components/dashboard/sidebar'
import { TriggerRunButton } from '@/components/dashboard/trigger-run-button'

export function AppHeader() {
  const { projects, activeProjectId } = useWorkspace()
  const pathname = usePathname()

  const activeProject = projects.find((p) => p.id === activeProjectId)

  const isRunsActive =
    activeProjectId && pathname.includes(`/projects/${activeProjectId}/runs`)
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
          <TriggerRunButton projectId={activeProjectId} />

          <HeaderNavButton
            href={`/projects/${activeProjectId}/runs`}
            icon={History}
            label="Runs"
            isActive={!!isRunsActive}
          />
          <HeaderNavButton
            href={`/projects/${activeProjectId}/settings`}
            icon={Settings}
            label="Settings"
            isActive={!!isSettingsActive}
          />
        </nav>
      )}
    </header>
  )
}

function HeaderNavButton({
  href,
  icon: Icon,
  label,
  isActive,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  isActive: boolean
}) {
  return (
    <a
      href={href}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{label}</span>
    </a>
  )
}
