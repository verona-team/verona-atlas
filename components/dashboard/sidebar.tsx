'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Plus, PanelLeftClose, PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/lib/workspace-context'
import { SignOutLink } from '@/components/dashboard/sign-out-link'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

function OrgOrb() {
  return (
    <div className="h-4 w-4 shrink-0 rounded-full bg-gradient-to-br from-cyan-400 via-violet-500 to-fuchsia-600 shadow-[0_0_6px_rgba(139,92,246,0.35)]" />
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
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 lg:hidden transition-opacity duration-300 ease-in-out',
          sidebarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100',
        )}
        onClick={toggleSidebar}
      />

      <aside
        className={cn(
          'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300 ease-in-out',
          sidebarCollapsed
            ? 'w-0 overflow-hidden opacity-0 lg:w-0'
            : 'fixed inset-y-0 left-0 z-50 w-64 opacity-100 lg:relative lg:z-auto',
        )}
      >
        {/* Top: orb + org name + collapse toggle */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2 min-w-0">
            <OrgOrb />
            <span className="text-sm font-normal truncate">{orgName || 'Verona'}</span>
          </div>
          <Tooltip>
            <TooltipTrigger render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleSidebar}
                className="text-sidebar-foreground/60 hover:text-sidebar-foreground shrink-0 ml-2"
              />
            }>
              <PanelLeftClose className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>Collapse sidebar</TooltipContent>
          </Tooltip>
        </div>

        {/* New project button */}
        <div className="px-3 py-3">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 border-sidebar-border text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setShowNewProjectModal(true)}
          >
            <Plus className="h-4 w-4" />
            New project
          </Button>
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
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
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
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleSidebar}
          className="text-muted-foreground hover:text-foreground"
        />
      }>
        <PanelLeft className="h-4 w-4" />
      </TooltipTrigger>
      <TooltipContent>Toggle sidebar</TooltipContent>
    </Tooltip>
  )
}
