'use client'

import { useState, useCallback, useEffect, useRef, type SyntheticEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  const [continuing, setContinuing] = useState(false)

  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')

  // Phase 2: integrations
  const [projectId, setProjectId] = useState<string | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])

  const githubComplete = isGitHubComplete(integrations)

  const lastIntegrationsKeyRef = useRef<string>('')
  const loadIntegrations = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/integrations`)
      if (!res.ok) return
      const data = await res.json()
      const next = (data.integrations || []) as IntegrationStatus[]
      const key = next
        .map((i) => `${i.id}:${i.status}:${JSON.stringify(i.meta ?? {})}`)
        .sort()
        .join('|')
      if (key !== lastIntegrationsKeyRef.current) {
        lastIntegrationsKeyRef.current = key
        setIntegrations(next)
      }
    } catch {
      /* ignore — the cards are already rendered in an empty state, and
         visibility/focus listeners below will retry when the user is
         engaged with the tab again */
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    // Background refresh only — cards already render in the empty state
    // directly from `onCreateProject`, so no render gate is needed here.
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
    setContinuing(false)
  }

  async function onCreateProject(e: SyntheticEvent<HTMLFormElement>) {
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
        // A brand-new project has no integrations yet, so render the
        // empty-state cards immediately. The effect below still fires a
        // background refresh to surface anything pre-seeded server-side.
        lastIntegrationsKeyRef.current = ''
        setIntegrations([])
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
    if (!githubComplete || !projectId || continuing) return
    setContinuing(true)
    try {
      await refreshProjects()
      router.push(`/projects/${projectId}`)
      setShowNewProjectModal(false)
      // NOTE: `onOpenChange` does NOT fire for programmatic close (only for
      // Escape / outside-click / close-button), so we must clear state here
      // explicitly. Otherwise the modal stays mounted under the dashboard
      // layout and the next "New project" click reopens it stuck on the
      // integrations step with a spinning "Opening chat..." button.
      reset()
    } catch (err) {
      setContinuing(false)
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <Dialog
      open={showNewProjectModal}
      onOpenChange={(open) => {
        if (!open && continuing) {
          // Navigation is already in flight — don't let the user close the
          // modal and lose the loading feedback.
          return
        }
        if (!open && step === 'integrations' && !githubComplete) {
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
        className="sm:max-w-2xl max-h-[85vh] overflow-y-auto"
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
              <div className="space-y-1.5">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My product"
                  autoComplete="off"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="app-url">App URL</Label>
                <Input
                  id="app-url"
                  type="url"
                  required
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  placeholder="https://app.example.com"
                  autoComplete="off"
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowNewProjectModal(false)
                    reset()
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating...' : 'Create project'}
                </Button>
              </DialogFooter>
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

            <div className="space-y-3 mt-2">
              <GitHubCard
                projectId={projectId!}
                integration={getStatus('github')}
                onRefresh={handleRefresh}
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
              />
            </div>

            <div className="pt-3">
              <Button
                onClick={handleContinueToChat}
                disabled={!githubComplete || continuing}
                className="w-full"
              >
                {continuing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Opening chat...
                  </>
                ) : (
                  <>Continue to Chat →</>
                )}
              </Button>
              {!githubComplete && !continuing && (
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
