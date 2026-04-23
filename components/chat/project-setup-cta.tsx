'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AdvancedIntegrationsSection,
  BraintrustCard,
  countConnectedAdvanced,
  GitHubCard,
  isGitHubComplete,
  LangSmithCard,
  PostHogCard,
  SentryCard,
  SlackCard,
  type IntegrationStatus,
} from '@/components/integrations/integration-cards'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/lib/workspace-context'

/**
 * Landing surface for a newly-created project that hasn't armed its
 * bootstrap turn yet. Rendered by `ProjectChatGate` when
 * `projects.bootstrap_dispatched_at` is NULL.
 *
 * Two goals:
 *  1. Let the user keep connecting integrations (Slack / PostHog / Sentry /
 *     ...) at their own pace, without the chat UI auto-sending the bootstrap
 *     turn to the agent behind their back.
 *  2. Give them an explicit "Continue to chat" action that (a) flips the
 *     DB flag via `/api/projects/:id/dispatch-bootstrap`, (b) informs the
 *     parent gate to mount `<ChatInterface>` which will fire its own
 *     bootstrap `useEffect`. That keeps the bootstrap logic in exactly one
 *     place (`ChatInterface`) with no double-send risk.
 *
 * GitHub integration status is fetched on mount and refreshed on
 * visibilitychange / window focus, mirroring `NewProjectModal`'s pattern so
 * OAuth popup flows work the same way here.
 */
export function ProjectSetupCTA({
  projectId,
  projectName,
  appUrl,
  initialGithubReady,
  onDispatched,
}: {
  projectId: string
  projectName: string
  appUrl: string
  /** Server-rendered GitHub readiness — avoids a first-paint flicker where the
   *  button is incorrectly disabled before the client fetch resolves. */
  initialGithubReady: boolean
  onDispatched: () => void
}) {
  const { refreshProjects } = useWorkspace()

  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [continuing, setContinuing] = useState(false)
  const lastIntegrationsKeyRef = useRef<string>('')

  const loadIntegrations = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations`)
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
      /* ignore — initial render already has SSR-derived `initialGithubReady`,
         and the visibility/focus listeners below will retry on re-engagement */
    }
  }, [projectId])

  useEffect(() => {
    loadIntegrations()
  }, [loadIntegrations])

  useEffect(() => {
    // NOTE: same pattern as `NewProjectModal` — named handlers so the same
    // references reach `removeEventListener`. Arrow wrappers would leak
    // listeners across projectId changes if this component were ever reused.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') loadIntegrations()
    }
    function handleFocus() {
      loadIntegrations()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadIntegrations])

  // `isGitHubComplete` checks both presence AND that a repo has been picked.
  // Fall back to the SSR-derived value until the first fetch lands, so the
  // Continue button isn't incorrectly disabled on initial paint for users
  // arriving from a working setup.
  const clientGithubReady = isGitHubComplete(integrations)
  const githubReady =
    integrations.length === 0 ? initialGithubReady : clientGithubReady

  const getStatus = useCallback(
    (type: string) =>
      integrations.find((i) => i.type === type && i.status === 'active'),
    [integrations],
  )

  const handleContinue = useCallback(async () => {
    if (!githubReady || continuing) return
    setContinuing(true)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/dispatch-bootstrap`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Could not start chat. Please try again.',
        )
      }
      // Refresh the sidebar so the "setup incomplete" dot disappears in sync
      // with the local mount swap. `router.refresh()` would also re-run this
      // page's SSR and render `<ChatInterface />` there — but we prefer the
      // in-memory swap so the user sees the chat view instantly, with no
      // second server round-trip.
      void refreshProjects()
      onDispatched()
    } catch (err) {
      setContinuing(false)
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    }
  }, [githubReady, continuing, projectId, refreshProjects, onDispatched])

  // Heading + subcopy branch on GitHub status. Even though GitHub can be
  // completed inline via `<GitHubCard>`, the initial framing matters: a user
  // who soft-closed the modal after skipping GitHub lands here with a clear
  // "Connect GitHub to continue" prompt rather than a generic one.
  const heading = githubReady
    ? `${projectName} is almost ready`
    : `Finish setting up ${projectName}`
  const subcopy = githubReady
    ? 'You\u2019ve connected GitHub. Connect Slack, PostHog, or Sentry now for richer analysis, or jump straight into chat and add them later.'
    : 'Connect GitHub so the agent can read your repo. Other integrations are optional and can be added anytime.'

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:py-14">
        <header className="mb-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {appUrl.replace(/^https?:\/\//, '')}
          </p>
          <h1 className="mt-2 text-2xl font-medium tracking-tight">
            {heading}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{subcopy}</p>
        </header>

        <div className="space-y-3">
          <GitHubCard
            projectId={projectId}
            integration={getStatus('github')}
            onRefresh={loadIntegrations}
            returnTo={`/projects/${projectId}`}
          />
          <PostHogCard
            projectId={projectId}
            integration={getStatus('posthog')}
            onRefresh={loadIntegrations}
          />
          <SlackCard
            projectId={projectId}
            integration={getStatus('slack')}
            onRefresh={loadIntegrations}
          />
          <AdvancedIntegrationsSection
            connectedCount={countConnectedAdvanced(integrations)}
          >
            <SentryCard
              projectId={projectId}
              integration={getStatus('sentry')}
              onRefresh={loadIntegrations}
            />
            <LangSmithCard
              projectId={projectId}
              integration={getStatus('langsmith')}
              onRefresh={loadIntegrations}
            />
            <BraintrustCard
              projectId={projectId}
              integration={getStatus('braintrust')}
              onRefresh={loadIntegrations}
            />
          </AdvancedIntegrationsSection>
        </div>

        <div className="mt-6">
          <Button
            onClick={handleContinue}
            disabled={!githubReady || continuing}
            size="lg"
            className="w-full h-11 text-sm"
          >
            {continuing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>Continue to chat →</>
            )}
          </Button>
          {!githubReady && !continuing && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Connect GitHub above to enable chat.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
