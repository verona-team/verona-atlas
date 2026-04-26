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
  userEmail: string
  projects: Project[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  showNewProjectModal: boolean
  settingsProjectId: string | null
}

interface WorkspaceActions {
  setActiveProjectId: (id: string | null) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  setShowNewProjectModal: (show: boolean) => void
  refreshProjects: () => Promise<void>
  openSettings: (projectId: string) => void
  closeSettings: () => void
}

type WorkspaceContextValue = WorkspaceState & WorkspaceActions

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

interface WorkspaceProviderProps {
  children: ReactNode
  orgId: string
  userEmail: string
  initialProjects: Project[]
}

const SIDEBAR_COLLAPSED_KEY = 'verona-sidebar-collapsed'

export function WorkspaceProvider({
  children,
  orgId,
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
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null)

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

  const openSettings = useCallback((projectId: string) => {
    setSettingsProjectId(projectId)
  }, [])

  const closeSettings = useCallback(() => {
    setSettingsProjectId(null)
  }, [])

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
        userEmail,
        projects,
        activeProjectId,
        sidebarCollapsed,
        showNewProjectModal,
        settingsProjectId,
        setActiveProjectId,
        setSidebarCollapsed,
        toggleSidebar,
        setShowNewProjectModal,
        refreshProjects,
        openSettings,
        closeSettings,
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
