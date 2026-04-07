'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ChevronRight } from 'lucide-react'
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
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
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
  const [credentialsOpen, setCredentialsOpen] = useState(false)

  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

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
    setAuthEmail('')
    setAuthPassword('')
    setProjectId(null)
    setIntegrations([])
    setCredentialsOpen(false)
  }

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, string> = { name, app_url: appUrl }
      if (authEmail.trim()) body.auth_email = authEmail.trim()
      if (authPassword) body.auth_password = authPassword

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

              <Collapsible open={credentialsOpen} onOpenChange={setCredentialsOpen}>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${credentialsOpen ? 'rotate-90' : ''}`} />
                  Test account credentials (optional)
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="space-y-3 mt-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="auth-email">Auth email</Label>
                      <Input
                        id="auth-email"
                        type="email"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        placeholder="tester@example.com"
                        autoComplete="off"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="auth-password">Auth password</Label>
                      <Input
                        id="auth-password"
                        type="password"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>

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
              <Button
                onClick={handleContinueToChat}
                disabled={!githubComplete}
                className="w-full"
              >
                Continue to Chat →
              </Button>
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
