'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { primaryGithubRepoFullName } from '@/lib/github-integration-config'
import type { Json } from '@/lib/supabase/types'

export type IntegrationStatus = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/*  Shared card wrapper                                                */
/* ------------------------------------------------------------------ */

export function IntegrationCard({
  title,
  description,
  connected,
  meta,
  required,
  children,
}: {
  title: string
  description: string
  connected: boolean
  meta?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {title}
            {required && (
              <span className="ml-2 text-xs font-normal text-amber-500">
                Required
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          {meta && <p className="text-xs text-muted-foreground/70 mt-0.5">{meta}</p>}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap ${connected ? 'bg-green-500/10 text-green-500' : 'text-muted-foreground/50'}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {children}
    </div>
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
  const repos = (integration?.meta?.repos as Array<{ full_name: string }>) || []
  const linkedRepo = repos[0]?.full_name

  function openGitHubInstall() {
    setWaiting(true)
    const rt = encodeURIComponent(returnTo || `/projects/${projectId}/settings`)
    installPopupRef.current =
      window.open(
        `/api/integrations/github/install?project_id=${projectId}&return_to=${rt}`,
        '_blank',
      ) ?? null
  }

  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/integrations/github/status?project_id=${projectId}`)
        if (res.ok) {
          const data = await res.json()
          if (data.connected) {
            await onRefresh()
            setWaiting(false)
            toast.success('GitHub connected')
            installPopupRef.current?.close()
            installPopupRef.current = null
            window.focus()
          }
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [waiting, projectId, onRefresh])

  return (
    <IntegrationCard
      title="GitHub"
      description="Connect a repository for code context and test planning."
      connected={!!integration}
      required
      meta={linkedRepo ? `Repository: ${linkedRepo}` : integration ? 'Select a repository below' : undefined}
    >
      {!integration ? (
        waiting ? (
          <p className="text-xs text-muted-foreground">Waiting for GitHub authorization...</p>
        ) : (
          <button onClick={openGitHubInstall} className="text-sm underline text-foreground/80 hover:text-foreground">
            Connect GitHub →
          </button>
        )
      ) : (
        <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />
      )}
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
        <button onClick={() => setExpanded(true)} className="text-sm underline text-foreground/80 hover:text-foreground">
          Connect PostHog →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Personal API key" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={phProjectId} onChange={(e) => setPhProjectId(e.target.value)} placeholder="PostHog Project ID" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={apiHost} onChange={(e) => setApiHost(e.target.value)} placeholder="API host (optional)" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <div className="flex gap-3">
            <button onClick={connect} disabled={submitting || !apiKey || !phProjectId} className="text-sm underline disabled:opacity-30">{submitting ? 'Connecting...' : 'Save'}</button>
            <button onClick={() => setExpanded(false)} className="text-sm opacity-50 underline">Cancel</button>
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
        <button onClick={() => setExpanded(true)} className="text-sm underline text-foreground/80 hover:text-foreground">Connect Sentry →</button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <input value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="Auth token" type="password" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} placeholder="Organization slug" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={projSlug} onChange={(e) => setProjSlug(e.target.value)} placeholder="Project slug" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <div className="flex gap-3">
            <button onClick={connect} disabled={submitting || !authToken || !orgSlug || !projSlug} className="text-sm underline disabled:opacity-30">{submitting ? 'Connecting...' : 'Save'}</button>
            <button onClick={() => setExpanded(false)} className="text-sm opacity-50 underline">Cancel</button>
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
        <button onClick={() => setExpanded(true)} className="text-sm underline text-foreground/80 hover:text-foreground">Connect LangSmith →</button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="LangSmith API key" type="password" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name (optional)" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <div className="flex gap-3">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-sm underline disabled:opacity-30">{submitting ? 'Connecting...' : 'Save'}</button>
            <button onClick={() => setExpanded(false)} className="text-sm opacity-50 underline">Cancel</button>
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
        <button onClick={() => setExpanded(true)} className="text-sm underline text-foreground/80 hover:text-foreground">Connect Braintrust →</button>
      )}
      {!integration && expanded && (
        <div className="space-y-3 mt-2">
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Braintrust API key" type="password" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <input value={btProjectName} onChange={(e) => setBtProjectName(e.target.value)} placeholder="Project name (optional)" className="w-full border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <div className="flex gap-3">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-sm underline disabled:opacity-30">{submitting ? 'Connecting...' : 'Save'}</button>
            <button onClick={() => setExpanded(false)} className="text-sm opacity-50 underline">Cancel</button>
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

  const channelName = integration?.meta?.channel_name as string | undefined

  function openSlackAuth() {
    setWaiting(true)
    const rt = encodeURIComponent(returnTo || `/projects/${projectId}/settings`)
    window.open(`/api/integrations/slack/authorize?project_id=${projectId}&return_to=${rt}`, '_blank')
  }

  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(async () => { await onRefresh() }, 2000)
    return () => clearInterval(interval)
  }, [waiting, onRefresh])

  useEffect(() => {
    if (waiting && integration) {
      setWaiting(false)
      toast.success('Slack connected')
    }
  }, [waiting, integration])

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
      meta={integration ? `${integration.meta?.team_name || 'Workspace'}${channelName ? ` · #${channelName}` : ''}` : undefined}
    >
      {!integration ? (
        waiting ? (
          <p className="text-xs text-muted-foreground">Waiting for Slack authorization...</p>
        ) : (
          <button onClick={openSlackAuth} className="text-sm underline text-foreground/80 hover:text-foreground">Connect Slack →</button>
        )
      ) : !channelName ? (
        <div>
          {!showChannels ? (
            <button onClick={loadChannels} disabled={loadingChannels} className="text-sm underline disabled:opacity-30">
              {loadingChannels ? 'Loading...' : 'Select a channel →'}
            </button>
          ) : (
            <div className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
              {channels.map((ch) => (
                <button key={ch.id} onClick={() => selectChannel(ch.id, ch.name)} disabled={saving} className="block w-full text-left px-2 py-1.5 rounded text-sm hover:bg-muted/50">#{ch.name}</button>
              ))}
              {channels.length === 0 && <p className="text-xs text-muted-foreground px-2 py-2">No channels found.</p>}
            </div>
          )}
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-xs text-muted-foreground underline">Change channel</button>
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
  const repos = (gh.meta?.repos as Array<Record<string, Json>>) || []
  return !!primaryGithubRepoFullName(repos)
}
