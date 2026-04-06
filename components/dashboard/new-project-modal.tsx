'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  GitHubCard,
  PostHogCard,
  SentryCard,
  LangSmithCard,
  BraintrustCard,
  SlackCard,
  isGitHubComplete,
  type IntegrationStatus,
} from '@/components/integrations/integration-cards'
import { useWorkspace } from '@/lib/workspace-context'

type Step = 'details' | 'integrations'

export function NewProjectModal() {
  const router = useRouter()
  const { showNewProjectModal, setShowNewProjectModal, refreshProjects } =
    useWorkspace()

  const [step, setStep] = useState<Step>('details')
  const [submitting, setSubmitting] = useState(false)

  // Phase 1: project details
  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  // Phase 2: integrations
  const [projectId, setProjectId] = useState<string | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)

  const githubComplete = isGitHubComplete(integrations)

  const loadIntegrations = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/integrations`)
      if (res.ok) {
        const data = await res.json()
        setIntegrations(data.integrations || [])
      }
    } catch {
    } finally {
      setLoadingIntegrations(false)
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    setLoadingIntegrations(true)
    loadIntegrations(projectId)
  }, [projectId, loadIntegrations])

  useEffect(() => {
    if (!projectId) return
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadIntegrations(projectId!)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', () => loadIntegrations(projectId!))
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', () => loadIntegrations(projectId!))
    }
  }, [projectId, loadIntegrations])

  function reset() {
    setStep('details')
    setName('')
    setAppUrl('')
    setProjectId(null)
    setIntegrations([])
  }

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, string> = { name, app_url: appUrl }

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast.error(
          typeof data.error === 'string'
            ? data.error
            : JSON.stringify(data.error ?? 'Request failed'),
        )
        return
      }
      if (data?.id) {
        if (data.warning) {
          toast.warning(data.warning, { duration: 8000 })
        }
        setProjectId(data.id)
        setStep('integrations')
        return
      }
      toast.error('Invalid response from server')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  const getStatus = (type: string) =>
    integrations.find((i) => i.type === type && i.status === 'active')

  const handleRefresh = useCallback(() => {
    if (projectId) loadIntegrations(projectId)
  }, [projectId, loadIntegrations])

  async function handleContinueToChat() {
    if (!githubComplete || !projectId) return
    await refreshProjects()
    setShowNewProjectModal(false)
    reset()
    router.push(`/projects/${projectId}`)
  }

  return (
    <Dialog
      open={showNewProjectModal}
      onOpenChange={(open) => {
        if (!open && step === 'integrations' && !githubComplete) {
          toast.error('Connect GitHub and select a repository to continue.')
          return
        }
        if (!open && step === 'details' && projectId) {
          toast.error('Connect GitHub and select a repository to continue.')
          return
        }
        if (!open) {
          setShowNewProjectModal(false)
          reset()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg max-h-[85vh] overflow-y-auto"
        showCloseButton={step === 'details' && !projectId}
      >
        {step === 'details' ? (
          <>
            <DialogHeader>
              <DialogTitle>New Project</DialogTitle>
              <DialogDescription>
                Set up your project, then connect your data sources.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={onCreateProject} className="space-y-4 mt-2">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  Project name
                </label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My product"
                  autoComplete="off"
                  autoFocus
                  className="w-full border-b border-border bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-foreground/30 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  App URL
                </label>
                <input
                  type="url"
                  required
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  placeholder="https://app.example.com"
                  autoComplete="off"
                  className="w-full border-b border-border bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-foreground/30 transition-colors"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewProjectModal(false)
                    reset()
                  }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {submitting ? 'Creating...' : 'Create project'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Connect Integrations</DialogTitle>
              <DialogDescription>
                GitHub is required. Other integrations can be added later from
                settings.
              </DialogDescription>
            </DialogHeader>

            {loadingIntegrations ? (
              <p className="text-sm text-muted-foreground py-4">Loading...</p>
            ) : (
              <div className="space-y-3 mt-2">
                <GitHubCard
                  projectId={projectId!}
                  integration={getStatus('github')}
                  onRefresh={handleRefresh}
                  returnTo={`/projects/${projectId}`}
                />
                <PostHogCard
                  projectId={projectId!}
                  integration={getStatus('posthog')}
                  onRefresh={handleRefresh}
                />
                <SentryCard
                  projectId={projectId!}
                  integration={getStatus('sentry')}
                  onRefresh={handleRefresh}
                />
                <LangSmithCard
                  projectId={projectId!}
                  integration={getStatus('langsmith')}
                  onRefresh={handleRefresh}
                />
                <BraintrustCard
                  projectId={projectId!}
                  integration={getStatus('braintrust')}
                  onRefresh={handleRefresh}
                />
                <SlackCard
                  projectId={projectId!}
                  integration={getStatus('slack')}
                  onRefresh={handleRefresh}
                  returnTo={`/projects/${projectId}`}
                />
              </div>
            )}

            <div className="pt-3">
              <button
                type="button"
                onClick={handleContinueToChat}
                disabled={!githubComplete}
                className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Continue to Chat →
              </button>
              {!githubComplete && (
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  Connect GitHub and select a repository to continue.
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
