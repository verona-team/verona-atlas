'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { useRouter, usePathname } from 'next/navigation'
import type { Project } from '@/lib/supabase/types'

interface WorkspaceState {
  orgId: string
  orgName: string
  userEmail: string
  projects: Project[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  showNewProjectModal: boolean
}

interface WorkspaceActions {
  setActiveProjectId: (id: string | null) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setShowNewProjectModal: (show: boolean) => void
  refreshProjects: () => Promise<void>
}

type WorkspaceContextValue = WorkspaceState & WorkspaceActions

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

interface WorkspaceProviderProps {
  children: ReactNode
  orgId: string
  orgName: string
  userEmail: string
  initialProjects: Project[]
}

const SIDEBAR_COLLAPSED_KEY = 'verona-sidebar-collapsed'

export function WorkspaceProvider({
  children,
  orgId,
  orgName,
  userEmail,
  initialProjects,
}: WorkspaceProviderProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(false)
  const [showNewProjectModal, setShowNewProjectModal] = useState(
    () => initialProjects.length === 0,
  )
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    null,
  )

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
          setSidebarCollapsedState(true)
        }
      } catch {}
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const match = pathname.match(/^\/projects\/([^/]+)/)
    if (match && match[1] !== 'new') {
      const id = match[1]
      queueMicrotask(() => setActiveProjectIdState(id))
    }
  }, [pathname])

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed))
    } catch {}
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed)
  }, [sidebarCollapsed, setSidebarCollapsed])

  const setActiveProjectId = useCallback(
    (id: string | null) => {
      queueMicrotask(() => setActiveProjectIdState(id))
      if (id) {
        router.push(`/projects/${id}`)
      }
    },
    [router],
  )

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects')
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) {
          setProjects(data)
        }
      }
    } catch {}
  }, [])

  return (
    <WorkspaceContext.Provider
      value={{
        orgId,
        orgName,
        userEmail,
        projects,
        activeProjectId,
        sidebarCollapsed,
        showNewProjectModal,
        setActiveProjectId,
        setSidebarCollapsed,
        toggleSidebar,
        setShowNewProjectModal,
        refreshProjects,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return ctx
}
