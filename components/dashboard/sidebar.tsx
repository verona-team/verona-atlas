'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Plus, PanelLeftClose, PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/lib/workspace-context'
import { SignOutLink } from '@/components/dashboard/sign-out-link'

function OrgOrb({ name }: { name: string }) {
  const letter = (name || 'V').charAt(0).toUpperCase()
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-sm">
      <span className="text-[10px] font-bold text-white leading-none">{letter}</span>
    </div>
  )
}

export function AppSidebar() {
  const {
    projects,
    activeProjectId,
    sidebarCollapsed,
    toggleSidebar,
    setShowNewProjectModal,
    orgName,
    userEmail,
  } = useWorkspace()
  const pathname = usePathname()

  const initials = userEmail
    .split('@')[0]
    .slice(0, 2)
    .toUpperCase()

  return (
    <>
      {/* Mobile overlay backdrop */}
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={toggleSidebar}
        />
      )}

      <aside
        className={cn(
          'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-200 ease-in-out',
          sidebarCollapsed
            ? 'w-0 overflow-hidden lg:w-0'
            : 'fixed inset-y-0 left-0 z-50 w-64 lg:relative lg:z-auto',
        )}
      >
        {/* Top: orb + org name + collapse toggle */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2 min-w-0">
            <OrgOrb name={orgName} />
            <span className="text-sm font-semibold truncate">{orgName || 'Verona'}</span>
          </div>
          <button
            onClick={toggleSidebar}
            className="rounded-md p-1 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors shrink-0 ml-2"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        {/* New Chat button */}
        <div className="px-3 py-3">
          <button
            onClick={() => setShowNewProjectModal(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>New project</span>
          </button>
        </div>

        {/* Project list */}
        <nav className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
          {projects.length === 0 && (
            <p className="px-3 py-6 text-xs text-sidebar-foreground/40 text-center">
              No projects yet
            </p>
          )}
          {projects.map((project) => {
            const isActive =
              project.id === activeProjectId ||
              pathname.startsWith(`/projects/${project.id}`)
            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className={cn(
                  'flex flex-col rounded-lg px-3 py-2 text-sm transition-colors truncate',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/80',
                )}
              >
                <span className="truncate font-medium">{project.name}</span>
                <span className="truncate text-xs opacity-50 mt-0.5">
                  {project.app_url.replace(/^https?:\/\//, '')}
                </span>
              </Link>
            )
          })}
        </nav>

        {/* Bottom: user info */}
        <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-medium">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-sidebar-foreground/80">
                {userEmail}
              </p>
            </div>
            <SignOutLink className="text-xs text-sidebar-foreground/40 hover:text-sidebar-foreground/70 transition-colors" />
          </div>
        </div>
      </aside>
    </>
  )
}

export function SidebarToggle() {
  const { sidebarCollapsed, toggleSidebar } = useWorkspace()
  if (!sidebarCollapsed) return null

  return (
    <button
      onClick={toggleSidebar}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  )
}
