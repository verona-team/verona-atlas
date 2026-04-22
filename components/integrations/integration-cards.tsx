'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

  return (
    <Card size="sm" className="ring-0 border border-border">
      <CardContent>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium flex items-center gap-2">
              {title}
              {required && (
                <Badge variant="outline" className="text-amber-500 border-amber-500/30">
                  Required
                </Badge>
              )}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
            {meta && <p className="text-xs text-muted-foreground/70 mt-0.5">{meta}</p>}
          </div>
          <Badge
            variant={status === 'connected' ? 'outline' : 'secondary'}
            className={`transition-colors duration-200 ${
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
        {children}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  GitHub                                                             */
/* ------------------------------------------------------------------ */

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
  const installPopupRef = useRef<Window | null>(null)
  const rawRepo = integration?.meta?.repo
  const linkedRepo =
    rawRepo != null &&
    typeof rawRepo === 'object' &&
    'full_name' in rawRepo
      ? String((rawRepo as { full_name: string }).full_name)
      : undefined

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

    async function checkStatus() {
      if (cancelled) return
      try {
        const res = await fetch(`/api/integrations/github/status?project_id=${projectId}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (!data.connected || cancelled) return
        await onRefresh()
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

    return () => {
      cancelled = true
      clearInterval(interval)
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
      meta={linkedRepo ? `Repository: ${linkedRepo}` : integration ? 'Select a repository below' : undefined}
    >
      <div className={`relative ${integration || waiting ? 'min-h-[96px]' : ''}`}>
        {showConnectCta && (
          <Button variant="link" size="sm" className="px-0" onClick={openGitHubInstall}>
            Connect GitHub →
          </Button>
        )}
        {waiting && !integration && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground transition-opacity duration-200">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Waiting for GitHub authorization…</span>
          </div>
        )}
        {integration && (
          <div className="transition-opacity duration-200">
            <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />
          </div>
        )}
      </div>
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
      meta={integration ? `Project: ${integration.meta?.posthog_project_id}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>
          Connect PostHog →
        </Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="ph-api-key">Personal API key</Label>
            <Input id="ph-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="phx_..." />
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
  const [orgSlug, setOrgSlug] = useState('')
  const [projSlug, setProjSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function connect() {
    setSubmitting(true)
    try {
      const res = await fetch('/api/integrations/sentry/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, authToken, organizationSlug: orgSlug, projectSlug: projSlug }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Failed to connect'); return }
      toast.success('Sentry connected')
      setExpanded(false)
      onRefresh()
    } catch { toast.error('Connection failed') } finally { setSubmitting(false) }
  }

  return (
    <IntegrationCard
      title="Sentry"
      description="Detect backend and frontend errors during test runs."
      connected={!!integration}
      meta={integration ? `${integration.meta?.organization_slug}/${integration.meta?.project_slug}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect Sentry →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="sentry-token">Auth token</Label>
            <Input id="sentry-token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="sntrys_..." type="password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sentry-org">Organization slug</Label>
            <Input id="sentry-org" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} placeholder="my-org" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sentry-proj">Project slug</Label>
            <Input id="sentry-proj" value={projSlug} onChange={(e) => setProjSlug(e.target.value)} placeholder="my-project" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={connect} disabled={submitting || !authToken || !orgSlug || !projSlug}>{submitting ? 'Connecting...' : 'Save'}</Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>Cancel</Button>
          </div>
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
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect LangSmith →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
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
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(true)}>Connect Braintrust →</Button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
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
  const [showChannels, setShowChannels] = useState(false)
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [saving, setSaving] = useState(false)
  const authPopupRef = useRef<Window | null>(null)

  const channelName = integration?.meta?.channel_name as string | undefined

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

  // Pre-fetch channels in the background once Slack is connected so the
  // dropdown renders instantly when the user opens it.
  useEffect(() => {
    if (!integration || channels.length > 0 || loadingChannels) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/integrations/slack/channels?project_id=${projectId}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (!cancelled) setChannels(data.channels || [])
      } catch {
        /* ignore */
      }
    })()
    return () => { cancelled = true }
  }, [integration, projectId, channels.length, loadingChannels])

  async function loadChannels() {
    setLoadingChannels(true)
    try {
      const res = await fetch(`/api/integrations/slack/channels?project_id=${projectId}`)
      if (res.ok) {
        const data = await res.json()
        setChannels(data.channels || [])
        setShowChannels(true)
      } else { toast.error('Failed to load channels') }
    } catch { toast.error('Failed to load channels') } finally { setLoadingChannels(false) }
  }

  async function selectChannel(channelId: string, name: string) {
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/slack/channels', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, channel_id: channelId, channel_name: name }),
      })
      if (res.ok) {
        toast.success(`Channel set to #${name}`)
        setShowChannels(false)
        onRefresh()
      } else { toast.error('Failed to set channel') }
    } catch { toast.error('Failed to set channel') } finally { setSaving(false) }
  }

  return (
    <IntegrationCard
      title="Slack"
      description="Get test run reports sent to a Slack channel."
      connected={!!integration}
      connecting={waiting && !integration}
      meta={integration ? `${integration.meta?.team_name || 'Workspace'}${channelName ? ` · #${channelName}` : ''}` : undefined}
    >
      <div className={`relative ${integration || waiting ? 'min-h-[40px]' : ''}`}>
        {!integration && !waiting && (
          <Button variant="link" size="sm" className="px-0" onClick={openSlackAuth}>Connect Slack →</Button>
        )}
        {waiting && !integration && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground transition-opacity duration-200">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Waiting for Slack authorization…</span>
          </div>
        )}
        {integration && !channelName && (
          <div>
            {!showChannels ? (
              <Button variant="link" size="sm" className="px-0" onClick={loadChannels} disabled={loadingChannels}>
                {loadingChannels ? 'Loading…' : 'Select a channel →'}
              </Button>
            ) : (
              <div className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
                {channels.map((ch) => (
                  <Button key={ch.id} variant="ghost" size="sm" className="w-full justify-start" onClick={() => selectChannel(ch.id, ch.name)} disabled={saving}>
                    #{ch.name}
                  </Button>
                ))}
                {channels.length === 0 && <p className="text-xs text-muted-foreground px-2 py-2">No channels found.</p>}
              </div>
            )}
          </div>
        )}
        {integration && channelName && (
          <Button variant="link" size="xs" className="px-0 text-muted-foreground" onClick={loadChannels} disabled={loadingChannels}>
            Change channel
          </Button>
        )}
      </div>
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
