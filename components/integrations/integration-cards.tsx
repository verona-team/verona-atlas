'use client'

import { Children, useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { GitHubInstallationPicker } from '@/components/integrations/github-installation-picker'
import { SlackChannelPicker } from '@/components/integrations/slack-channel-picker'
import { Card, CardContent } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type IntegrationStatus = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
}

type OAuthMessage = {
  source?: string
  integration?: string
}

/**
 * Listen for the oauth-complete popup's postMessage; invoke `onMatch` when
 * the message is for this integration. Returns a cleanup function.
 */
function useOAuthPopupListener(
  integrationType: string,
  enabled: boolean,
  onMatch: () => void,
) {
  useEffect(() => {
    if (!enabled) return
    function handler(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      const data = event.data as OAuthMessage | null
      if (!data || data.source !== 'verona-oauth') return
      if (data.integration !== integrationType) return
      onMatch()
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [enabled, integrationType, onMatch])
}

/* ------------------------------------------------------------------ */
/*  Shared card wrapper                                                */
/* ------------------------------------------------------------------ */

export function IntegrationCard({
  title,
  description,
  connected,
  connecting,
  meta,
  required,
  children,
}: {
  title: string
  description: string
  connected: boolean
  connecting?: boolean
  meta?: string
  required?: boolean
  children: React.ReactNode
}) {
  const status: 'connected' | 'connecting' | 'idle' = connected
    ? 'connected'
    : connecting
      ? 'connecting'
      : 'idle'

  // A card only needs a body section when there is interactive content to
  // render (e.g. a "Connect" CTA, the repo picker, the channel picker, or a
  // form). Treating empty bodies as absent lets fully-connected cards with no
  // further action (e.g. a connected PostHog card that only shows "Project:
  // 325427" as meta) collapse to a tight single row without baked-in empty
  // whitespace — and gives them a touch more breathing room between the
  // title and the subtitle, since they aren't followed by any body.
  //
  // We must count renderable children specifically: the integration cards
  // below commonly pass short-circuited branches like `{cond && <X/>}` that
  // evaluate to `false` when hidden, so `children` is often `[false, false]`
  // even when nothing should render. `Children.toArray` strips out React's
  // non-rendering values (null, undefined, booleans) for us.
  const hasBody = Children.toArray(children).length > 0

  return (
    <Card size="sm" className={`ring-0 border border-border ${hasBody ? 'py-3' : 'py-4'}`}>
      <CardContent>
        <div className={`flex items-center justify-between gap-3 ${hasBody ? 'mb-2' : ''}`}>
          <div className="min-w-0">
            <h3 className="text-sm font-medium flex items-center gap-2">
              {title}
              {required && (
                <Badge variant="outline" className="text-amber-500 border-amber-500/30">
                  Required
                </Badge>
              )}
            </h3>
            <p className={`text-xs text-muted-foreground ${hasBody ? 'mt-0.5' : 'mt-1.5'}`}>
              {meta || description}
            </p>
          </div>
          <Badge
            variant={status === 'connected' ? 'outline' : 'secondary'}
            className={`transition-colors duration-200 shrink-0 ${
              status === 'connected'
                ? 'border-green-500/30 text-green-500'
                : status === 'connecting'
                  ? 'border-border text-muted-foreground'
                  : ''
            }`}
          >
            {status === 'connected'
              ? 'Connected'
              : status === 'connecting'
                ? 'Connecting…'
                : 'Not connected'}
          </Badge>
        </div>
        {hasBody && <div>{children}</div>}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  GitHub                                                             */
/* ------------------------------------------------------------------ */

// Cap the waiting-for-auth state so a failed connect (popup closed, auth
// abandoned, or transient status API failure) can't leave the card spinning
// forever. Two minutes is long enough to cover the slowest legitimate
// GitHub install flow — including 2FA prompts and "select which repos"
// pickers — while still bailing out before it feels stuck.
const GITHUB_WAITING_TIMEOUT_MS = 120_000

// Grace period before we let a closed popup bail us out. Some browsers mark
// `window.closed === true` for a brief moment during the cross-origin
// redirect dance, so we don't want to react to the first tick.
const POPUP_CLOSE_GRACE_MS = 1_500

export function GitHubCard({
  projectId,
  integration,
  onRefresh,
  returnTo,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
  returnTo?: string
}) {
  const [waiting, setWaiting] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const installPopupRef = useRef<Window | null>(null)

  function openGitHubInstall() {
    setWaiting(true)
    // Redirect the popup to /auth/oauth-complete so it closes itself
    // and notifies the parent window via postMessage.
    const rt = encodeURIComponent(returnTo || `/auth/oauth-complete?integration=github`)
    installPopupRef.current =
      window.open(
        `/api/integrations/github/install?project_id=${projectId}&return_to=${rt}`,
        '_blank',
      ) ?? null
  }

  useOAuthPopupListener('github', waiting, () => {
    void onRefresh()
  })

  useEffect(() => {
    if (!waiting) return

    let cancelled = false
    const popupOpenedAt = Date.now()

    async function checkStatus() {
      if (cancelled) return
      try {
        const res = await fetch(`/api/integrations/github/status?project_id=${projectId}`)
        if (!res.ok || cancelled) return
        const data = (await res.json()) as {
          connected?: boolean
          reason?: string
        }
        if (cancelled) return
        if (data.connected) {
          await onRefresh()
          return
        }
        // Structured non-success reasons — stop polling and tell the user
        // what's wrong instead of spinning forever. This is the signal
        // layer the backend added so failure modes surface cleanly rather
        // than running out the 2-minute hard timeout.
        if (data.reason === 'AMBIGUOUS_MULTIPLE_INSTALLATIONS') {
          if (cancelled) return
          setWaiting(false)
          installPopupRef.current?.close()
          installPopupRef.current = null
          // Surface the in-app picker instead of leaving the user on
          // GitHub's "configure installation" screen with no next
          // step. The picker reads the stored OAuth token to list
          // installations and lets the user pick one; without it the
          // multi-install case would dead-end the same way the
          // original single-install "second account" bug did.
          setPickerOpen(true)
          return
        }
      } catch {
        /* ignore */
      }
    }

    void checkStatus()
    const interval = setInterval(() => void checkStatus(), 1500)

    function onVisibility() {
      if (document.visibilityState === 'visible') void checkStatus()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Safety net: if the popup is closed (manually or by the oauth-complete
    // page) but the backend never observed a connection, give up instead of
    // polling forever. The status endpoint is idempotent, so one final poll
    // tells us whether a late webhook/callback already linked us.
    const popupWatcher = setInterval(() => {
      if (cancelled) return
      const popup = installPopupRef.current
      if (!popup) return
      if (!popup.closed) return
      if (Date.now() - popupOpenedAt < POPUP_CLOSE_GRACE_MS) return
      clearInterval(popupWatcher)
      void (async () => {
        await checkStatus()
        if (cancelled) return
        setWaiting(false)
        installPopupRef.current = null
      })()
    }, 500)

    // Hard timeout — even if the popup remains open indefinitely (e.g. the
    // user wandered off), we must not leave the UI in a permanent spinning
    // state. This is the last line of defense against the infinite-loop
    // bug that motivated this component.
    const hardTimeout = setTimeout(() => {
      if (cancelled) return
      setWaiting(false)
      toast.error(
        "GitHub is taking a while. Close the popup and try again if it's stuck.",
      )
    }, GITHUB_WAITING_TIMEOUT_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
      clearInterval(popupWatcher)
      clearTimeout(hardTimeout)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [waiting, projectId, onRefresh])

  // When the backend confirms the integration exists, resolve the waiting
  // state in a single effect — avoids the old double-flash (setWaiting(false)
  // inside checkStatus, then a rerender with integration present).
  const previouslyConnectedRef = useRef(!!integration)
  useEffect(() => {
    const nowConnected = !!integration
    if (waiting && nowConnected) {
      // Sync our transient "waiting" state once the server confirms the
      // integration exists. This is a legitimate external-event-driven
      // reset — not a derived value we can compute in render, because we
      // also fire one-shot side effects (popup.close(), toast).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWaiting(false)
      installPopupRef.current?.close()
      installPopupRef.current = null
      if (!previouslyConnectedRef.current) {
        toast.success('GitHub connected')
        window.focus()
      }
    }
    previouslyConnectedRef.current = nowConnected
  }, [waiting, integration])

  const showConnectCta = !integration && !waiting

  return (
    <IntegrationCard
      title="GitHub"
      description="Connect a repository for code context and test planning."
      connected={!!integration}
      connecting={waiting && !integration}
      required
    >
      {showConnectCta && (
        <Button variant="link" size="sm" className="px-0" onClick={openGitHubInstall}>
          Connect GitHub →
        </Button>
      )}
      {waiting && !integration && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span>Waiting for GitHub authorization…</span>
        </div>
      )}
      {integration && <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />}
      <GitHubInstallationPicker
        open={pickerOpen}
        projectId={projectId}
        onOpenChange={setPickerOpen}
        onLinked={onRefresh}
      />
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  PostHog                                                            */
/* ------------------------------------------------------------------ */

export function PostHogCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [phProjectId, setPhProjectId] = useState('')
  const [apiHost, setApiHost] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function connect() {
    setSubmitting(true)
    try {
      const body: Record<string, string> = {
        projectId,
        posthogApiKey: apiKey,
        posthogProjectId: phProjectId,
      }
      if (apiHost.trim()) body.apiHost = apiHost.trim()

      const res = await fetch('/api/integrations/posthog/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect')
        return
      }
      toast.success('PostHog connected')
      setExpanded(false)
      onRefresh()
    } catch {
      toast.error('Connection failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <IntegrationCard
      title="PostHog"
      description="Monitor analytics events and session recordings."
      connected={!!integration}
      connecting={submitting && !integration}
      meta={integration ? `Project: ${integration.meta?.posthog_project_id}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>
          Connect PostHog →
        </Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ph-api-key">Personal API key</Label>
            <Input id="ph-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="phx_..." type="password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ph-project-id">PostHog Project ID</Label>
            <Input id="ph-project-id" value={phProjectId} onChange={(e) => setPhProjectId(e.target.value)} placeholder="12345" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ph-api-host">API host (optional)</Label>
            <Input id="ph-api-host" value={apiHost} onChange={(e) => setApiHost(e.target.value)} placeholder="https://app.posthog.com" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={connect} disabled={submitting || !apiKey || !phProjectId}>
              {submitting ? 'Connecting...' : 'Save'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Sentry                                                             */
/* ------------------------------------------------------------------ */

type SentryDiscoveredProject = {
  organizationSlug: string
  projectSlug: string
  projectName: string
}

// Encodes the org/project pair as a single string for the Select value, since
// only the pair uniquely identifies a project (a project slug can repeat
// across orgs the token has access to).
function projectKey(p: { organizationSlug: string; projectSlug: string }): string {
  return `${p.organizationSlug}/${p.projectSlug}`
}

export function SentryCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [authToken, setAuthToken] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [projects, setProjects] = useState<SentryDiscoveredProject[] | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  function resetForm() {
    setAuthToken('')
    setDiscovering(false)
    setDiscoverError(null)
    setProjects(null)
    setSelectedKey('')
  }

  function useDifferentToken() {
    setProjects(null)
    setSelectedKey('')
    setDiscoverError(null)
  }

  async function discover() {
    setDiscovering(true)
    setDiscoverError(null)
    try {
      const res = await fetch('/api/integrations/sentry/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken }),
      })
      const data = (await res.json()) as {
        projects?: SentryDiscoveredProject[]
        error?: string
      }
      if (!res.ok) {
        setDiscoverError(data.error || 'Failed to reach Sentry')
        return
      }
      const list = data.projects ?? []
      setProjects(list)
      if (list.length === 1) setSelectedKey(projectKey(list[0]))
    } catch {
      setDiscoverError('Failed to reach Sentry')
    } finally {
      setDiscovering(false)
    }
  }

  async function connect() {
    const selected = projects?.find((p) => projectKey(p) === selectedKey)
    if (!selected) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/integrations/sentry/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          authToken,
          organizationSlug: selected.organizationSlug,
          projectSlug: selected.projectSlug,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect')
        return
      }
      toast.success('Sentry connected')
      setExpanded(false)
      resetForm()
      onRefresh()
    } catch {
      toast.error('Connection failed')
    } finally {
      setSubmitting(false)
    }
  }

  function cancel() {
    setExpanded(false)
    resetForm()
  }

  return (
    <IntegrationCard
      title="Sentry"
      description="Detect backend and frontend errors during test runs."
      connected={!!integration}
      connecting={submitting && !integration}
      meta={integration ? `${integration.meta?.organization_slug}/${integration.meta?.project_slug}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect Sentry →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3">
          {projects === null ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="sentry-token">Auth token</Label>
                <Input
                  id="sentry-token"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  placeholder="sntryu_..."
                  type="password"
                />
                <p className="text-xs text-muted-foreground">
                  Create a <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">User Auth Token</a> with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">project:read</code> and <code className="rounded bg-muted px-1 py-0.5 text-[11px]">event:read</code> scopes. We&apos;ll list the projects it can access.
                </p>
              </div>
              {discoverError && (
                <p className="text-xs text-destructive">{discoverError}</p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={discover} disabled={discovering || !authToken}>
                  {discovering ? 'Finding projects…' : 'Find projects'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
              </div>
            </>
          ) : projects.length === 0 ? (
            <>
              <p className="text-xs text-muted-foreground">
                This token has no project access. Generate a token with <code className="rounded bg-muted px-1 py-0.5 text-[11px]">project:read</code> scope on the project you want to connect.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={useDifferentToken}>Use a different token</Button>
                <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
              </div>
            </>
          ) : projects.length === 1 ? (
            <>
              <div className="space-y-1.5">
                <Label>Project</Label>
                <p className="text-sm font-medium">
                  {projects[0].organizationSlug}/{projects[0].projectSlug}
                </p>
                <button
                  type="button"
                  onClick={useDifferentToken}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Use a different token
                </button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={connect} disabled={submitting}>
                  {submitting ? 'Connecting…' : 'Save'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="sentry-project-select">Project</Label>
                <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v ?? '')}>
                  <SelectTrigger id="sentry-project-select">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={projectKey(p)} value={projectKey(p)}>
                        {p.organizationSlug}/{p.projectSlug}
                        {p.projectName && p.projectName !== p.projectSlug ? ` — ${p.projectName}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={useDifferentToken}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Use a different token
                </button>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={connect} disabled={submitting || !selectedKey}>
                  {submitting ? 'Connecting…' : 'Save'}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  LangSmith                                                          */
/* ------------------------------------------------------------------ */

export function LangSmithCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [projectName, setProjectName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function connect() {
    setSubmitting(true)
    try {
      const body: Record<string, string> = { projectId, apiKey }
      if (projectName.trim()) body.projectName = projectName.trim()
      const res = await fetch('/api/integrations/langsmith/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to connect'); return }
      toast.success('LangSmith connected')
      setExpanded(false)
      onRefresh()
    } catch { toast.error('Connection failed') } finally { setSubmitting(false) }
  }

  return (
    <IntegrationCard
      title="LangSmith"
      description="Trace LLM calls and detect failures."
      connected={!!integration}
      connecting={submitting && !integration}
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect LangSmith →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ls-api-key">LangSmith API key</Label>
            <Input id="ls-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="lsv2_..." type="password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ls-project">Project name (optional)</Label>
            <Input id="ls-project" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="default" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={connect} disabled={submitting || !apiKey}>{submitting ? 'Connecting...' : 'Save'}</Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Braintrust                                                         */
/* ------------------------------------------------------------------ */

export function BraintrustCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [btProjectName, setBtProjectName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function connect() {
    setSubmitting(true)
    try {
      const body: Record<string, string> = { projectId, apiKey }
      if (btProjectName.trim()) body.braintrustProjectName = btProjectName.trim()
      const res = await fetch('/api/integrations/braintrust/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to connect'); return }
      toast.success('Braintrust connected')
      setExpanded(false)
      onRefresh()
    } catch { toast.error('Connection failed') } finally { setSubmitting(false) }
  }

  return (
    <IntegrationCard
      title="Braintrust"
      description="Evaluate LLM outputs and track scores."
      connected={!!integration}
      connecting={submitting && !integration}
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect Braintrust →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bt-api-key">Braintrust API key</Label>
            <Input id="bt-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." type="password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bt-project">Project name (optional)</Label>
            <Input id="bt-project" value={btProjectName} onChange={(e) => setBtProjectName(e.target.value)} placeholder="my-project" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={connect} disabled={submitting || !apiKey}>{submitting ? 'Connecting...' : 'Save'}</Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Slack                                                              */
/* ------------------------------------------------------------------ */

export function SlackCard({
  projectId,
  integration,
  onRefresh,
  returnTo,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
  returnTo?: string
}) {
  const [waiting, setWaiting] = useState(false)
  const authPopupRef = useRef<Window | null>(null)

  const teamName = integration?.meta?.team_name as string | undefined
  const currentChannelId = integration?.meta?.channel_id as string | undefined

  function openSlackAuth() {
    setWaiting(true)
    const rt = encodeURIComponent(returnTo || `/auth/oauth-complete?integration=slack`)
    authPopupRef.current =
      window.open(`/api/integrations/slack/authorize?project_id=${projectId}&return_to=${rt}`, '_blank') ?? null
  }

  useOAuthPopupListener('slack', waiting, () => {
    void onRefresh()
  })

  useEffect(() => {
    if (!waiting) return

    let cancelled = false

    async function refresh() {
      if (cancelled) return
      try {
        await onRefresh()
      } catch {
        /* ignore */
      }
    }

    void refresh()
    const interval = setInterval(() => void refresh(), 1500)

    function onVisibility() {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [waiting, onRefresh])

  const previouslyConnectedRef = useRef(!!integration)
  useEffect(() => {
    const nowConnected = !!integration
    if (waiting && nowConnected) {
      // Sync transient "waiting" state once the server confirms the
      // integration exists. Legitimate external-event-driven reset paired
      // with one-shot side effects (popup.close(), toast).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWaiting(false)
      authPopupRef.current?.close()
      authPopupRef.current = null
      if (!previouslyConnectedRef.current) {
        toast.success('Slack connected')
        window.focus()
      }
    }
    previouslyConnectedRef.current = nowConnected
  }, [waiting, integration])

  return (
    <IntegrationCard
      title="Slack"
      description="Get test run reports sent to a Slack channel."
      connected={!!integration}
      connecting={waiting && !integration}
      meta={integration && teamName ? `Workspace: ${teamName}` : undefined}
    >
      {!integration && !waiting && (
        <Button variant="link" size="sm" className="px-0" onClick={openSlackAuth}>
          Connect Slack →
        </Button>
      )}
      {waiting && !integration && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span>Waiting for Slack authorization…</span>
        </div>
      )}
      {integration && (
        <SlackChannelPicker
          projectId={projectId}
          currentChannelId={currentChannelId}
          autoDefault={!currentChannelId}
          onSaved={onRefresh}
        />
      )}
    </IntegrationCard>
  )
}

/* ------------------------------------------------------------------ */
/*  Helper: check if GitHub setup is complete                          */
/* ------------------------------------------------------------------ */

export function isGitHubComplete(integrations: IntegrationStatus[]): boolean {
  const gh = integrations.find((i) => i.type === 'github' && i.status === 'active')
  if (!gh) return false
  const repo = gh.meta?.repo as { full_name?: string } | null | undefined
  return typeof repo?.full_name === 'string' && repo.full_name.length > 0
}

/* ------------------------------------------------------------------ */
/*  Advanced integrations accordion                                    */
/* ------------------------------------------------------------------ */

/**
 * The integration types hidden behind the "More integrations" accordion.
 * These are niche enough (Slack reporting, error monitoring, LLM
 * observability) that surfacing them to every user adds more noise than
 * signal — GitHub + PostHog cover the core path on their own.
 *
 * Exported so callers can share one source of truth for both the UI
 * (accordion contents) and the "is anything connected?" computation
 * (accordion default-open state + badge count).
 */
export const ADVANCED_INTEGRATION_TYPES = ['slack', 'sentry', 'langsmith', 'braintrust'] as const

export type AdvancedIntegrationType = (typeof ADVANCED_INTEGRATION_TYPES)[number]

/**
 * How many of the advanced integrations are currently connected.
 *
 * Used by `AdvancedIntegrationsSection` to:
 *   1. Auto-expand the accordion when the user already has one of these
 *      connected (so their live state is never hidden).
 *   2. Render a "N connected" pill on the collapsed trigger, so the user
 *      always sees at a glance that there's active state inside.
 */
export function countConnectedAdvanced(
  integrations: IntegrationStatus[],
): number {
  return integrations.filter(
    (i) =>
      i.status === 'active' &&
      (ADVANCED_INTEGRATION_TYPES as readonly string[]).includes(i.type),
  ).length
}

/**
 * A labeled accordion that groups the rarely-needed integrations
 * (Slack, Sentry, LangSmith, Braintrust) behind a "More integrations"
 * trigger.
 *
 * Behaviour:
 *   - Collapsed by default when nothing inside is connected.
 *   - Auto-expands on mount when at least one inside is connected, so
 *     users never lose visibility of live integration state.
 *   - Always shows a count badge on the trigger when anything is
 *     connected, including when collapsed — that way, even if the user
 *     re-collapses the section after the auto-expand, the state is still
 *     visually represented in the closed header.
 *
 * The children (rendered inside `CollapsibleContent`) are the caller's
 * responsibility — this component is deliberately layout-only so it can
 * wrap both the new-project-modal integration cards and the
 * settings-page integration cards without coupling to either.
 */
export function AdvancedIntegrationsSection({
  connectedCount,
  children,
}: {
  connectedCount: number
  children: React.ReactNode
}) {
  // One-shot default: open if the user already has something connected,
  // otherwise start closed. After mount, we let the user drive the open
  // state directly — we do NOT force it back open on every render if
  // `connectedCount` flips to >0, because that would fight the user if
  // they explicitly collapsed the section after connecting something.
  const [open, setOpen] = useState(connectedCount > 0)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <ChevronDown
            className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-0' : '-rotate-90'}`}
            aria-hidden
          />
          <span className="uppercase tracking-wider">More integrations</span>
          {connectedCount > 0 && (
            <Badge
              variant="outline"
              className="h-5 px-1.5 border-green-500/30 text-green-500 text-[10px]"
            >
              {connectedCount} connected
            </Badge>
          )}
        </span>
      </CollapsibleTrigger>
      {/*
        Animate the height so the Danger Zone card below doesn't jump
        abruptly when the accordion opens/closes. Base-ui's Collapsible
        exposes `--collapsible-panel-height` on the panel element, which
        we bind to `height` so the browser can interpolate between 0 and
        the measured content height. `overflow-hidden` is required to
        clip the content while the height is less than its natural size;
        without it the children would visibly overflow during the
        transition. `keepMounted` preserves in-progress credential form
        state if the user accidentally collapses the section mid-flow.
      */}
      <CollapsibleContent
        keepMounted
        className="overflow-hidden transition-[height] duration-200 ease-out h-[var(--collapsible-panel-height)] data-[starting-style]:h-0 data-[ending-style]:h-0"
      >
        <div className="space-y-3 pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
