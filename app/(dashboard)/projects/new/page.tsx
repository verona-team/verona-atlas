'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useWorkspace } from '@/lib/workspace-context'

export default function NewProjectPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const existingProjectId = searchParams.get('projectId')
  const { setShowNewProjectModal } = useWorkspace()

  useEffect(() => {
    if (existingProjectId) {
      router.replace(`/projects/${existingProjectId}`)
    } else {
      setShowNewProjectModal(true)
      router.replace('/projects')
    }
  }, [existingProjectId, router, setShowNewProjectModal])

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground">Redirecting...</p>
    </div>
  )
}
