'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

type IntegrationStatus = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
}

export default function ProjectSetupPage() {
  const router = useRouter()
  const params = useParams<{ projectId: string }>()
  const searchParams = useSearchParams()
  const projectId = params.projectId
  const toastShown = useRef(false)

  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [loading, setLoading] = useState(true)

  const loadIntegrations = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/integrations`)
      if (res.ok) {
        const data = await res.json()
        setIntegrations(data.integrations || [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadIntegrations()
  }, [loadIntegrations])

  useEffect(() => {
    if (toastShown.current) return
    const ghConnected = searchParams.get('github')
    const slackConnected = searchParams.get('slack')
    if (ghConnected === 'connected') {
      toast.success('GitHub connected')
      toastShown.current = true
    }
    if (slackConnected === 'connected') {
      toast.success('Slack connected')
      toastShown.current = true
    }
  }, [searchParams])

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadIntegrations()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', loadIntegrations)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', loadIntegrations)
    }
  }, [loadIntegrations])

  const getStatus = (type: string) =>
    integrations.find((i) => i.type === type && i.status === 'active')

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-4xl mb-4">Connect Integrations</h1>
      <p className="text-lg opacity-50 mb-12">
        Connect your tools so the QA agent has full context when testing your app. You can always configure these later from project settings.
      </p>

      {loading ? (
        <p className="text-xl opacity-40">Loading...</p>
      ) : (
        <div className="space-y-6">
          <GitHubCard projectId={projectId} integration={getStatus('github')} onRefresh={loadIntegrations} />
          <PostHogCard projectId={projectId} integration={getStatus('posthog')} onRefresh={loadIntegrations} />
          <SentryCard projectId={projectId} integration={getStatus('sentry')} onRefresh={loadIntegrations} />
          <LangSmithCard projectId={projectId} integration={getStatus('langsmith')} onRefresh={loadIntegrations} />
          <BraintrustCard projectId={projectId} integration={getStatus('braintrust')} onRefresh={loadIntegrations} />
          <SlackCard projectId={projectId} integration={getStatus('slack')} onRefresh={loadIntegrations} />
        </div>
      )}

      <div className="flex gap-8 pt-12 pb-8">
        <button
          onClick={() => router.push(`/projects/${projectId}`)}
          className="text-xl underline"
        >
          {integrations.some((i) => i.status === 'active') ? 'Done →' : 'Skip for now →'}
        </button>
      </div>
    </div>
  )
}

function IntegrationCard({
  title,
  description,
  connected,
  meta,
  children,
}: {
  title: string
  description: string
  connected: boolean
  meta?: string
  children: React.ReactNode
}) {
  return (
    <div className="border rounded-lg p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-xl font-medium">{title}</h3>
          <p className="text-base opacity-50 mt-1">{description}</p>
          {meta && <p className="text-base opacity-40 mt-1">{meta}</p>}
        </div>
        <span className={`text-sm px-3 py-1 rounded-full ${connected ? 'bg-green-500/10 text-green-600' : 'opacity-40'}`}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      {children}
    </div>
  )
}

function GitHubCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [waiting, setWaiting] = useState(false)
  const repos = (integration?.meta?.repos as Array<{ full_name: string }>) || []
  const repoNames = repos.map((r) => r.full_name).join(', ')

  function openGitHubInstall() {
    setWaiting(true)
    const returnTo = encodeURIComponent(`/projects/${projectId}/setup`)
    window.open(
      `/api/integrations/github/install?project_id=${projectId}&return_to=${returnTo}`,
      '_blank',
    )
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
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [waiting, projectId, onRefresh])

  useEffect(() => {
    if (waiting && integration) {
      setWaiting(false)
      toast.success('GitHub connected')
    }
  }, [waiting, integration])

  return (
    <IntegrationCard
      title="GitHub"
      description="Access private repos, pull recent commits, and use code changes as context for QA tests."
      connected={!!integration}
      meta={repoNames ? `Repos: ${repoNames}` : undefined}
    >
      {!integration ? (
        waiting ? (
          <p className="text-base opacity-50">Waiting for GitHub authorization... Complete the installation in the opened tab.</p>
        ) : (
          <button onClick={openGitHubInstall} className="text-lg underline">
            Connect GitHub →
          </button>
        )
      ) : (
        <p className="text-base opacity-40">Manage repos in project settings.</p>
      )}
    </IntegrationCard>
  )
}

function PostHogCard({
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
      description="Monitor analytics events, session recordings, and track frontend exceptions."
      connected={!!integration}
      meta={integration ? `Project: ${integration.meta?.posthog_project_id}` : undefined}
    >
      {!integration && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-lg underline">
          Connect PostHog →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-4 mt-4">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Personal API key"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={phProjectId}
            onChange={(e) => setPhProjectId(e.target.value)}
            placeholder="PostHog Project ID"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={apiHost}
            onChange={(e) => setApiHost(e.target.value)}
            placeholder="API host (optional, e.g. https://eu.posthog.com)"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey || !phProjectId} className="text-base underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-base opacity-50 underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

function SentryCard({
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
        body: JSON.stringify({
          projectId,
          authToken,
          organizationSlug: orgSlug,
          projectSlug: projSlug,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect')
        return
      }
      toast.success('Sentry connected')
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
      title="Sentry"
      description="Detect backend and frontend errors during test runs."
      connected={!!integration}
      meta={integration ? `${integration.meta?.organization_slug}/${integration.meta?.project_slug}` : undefined}
    >
      {!integration && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-lg underline">
          Connect Sentry →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-4 mt-4">
          <input
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="Auth token"
            type="password"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            placeholder="Organization slug"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={projSlug}
            onChange={(e) => setProjSlug(e.target.value)}
            placeholder="Project slug"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !authToken || !orgSlug || !projSlug} className="text-base underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-base opacity-50 underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

function LangSmithCard({
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

      const res = await fetch('/api/integrations/langsmith/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect')
        return
      }
      toast.success('LangSmith connected')
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
      title="LangSmith"
      description="Trace LLM calls and detect failures in AI-powered features."
      connected={!!integration}
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-lg underline">
          Connect LangSmith →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-4 mt-4">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="LangSmith API key"
            type="password"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Project name (optional)"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-base underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-base opacity-50 underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

function BraintrustCard({
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

      const res = await fetch('/api/integrations/braintrust/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to connect')
        return
      }
      toast.success('Braintrust connected')
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
      title="Braintrust"
      description="Evaluate LLM outputs and track evaluation scores during test runs."
      connected={!!integration}
      meta={integration?.meta?.project_name ? `Project: ${integration.meta.project_name}` : undefined}
    >
      {!integration && !expanded && (
        <button onClick={() => setExpanded(true)} className="text-lg underline">
          Connect Braintrust →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-4 mt-4">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Braintrust API key"
            type="password"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <input
            value={btProjectName}
            onChange={(e) => setBtProjectName(e.target.value)}
            placeholder="Project name (optional)"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-base underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-base opacity-50 underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </IntegrationCard>
  )
}

function SlackCard({
  projectId,
  integration,
  onRefresh,
}: {
  projectId: string
  integration?: IntegrationStatus
  onRefresh: () => void
}) {
  const [waiting, setWaiting] = useState(false)
  const [showChannels, setShowChannels] = useState(false)
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [currentChannelId, setCurrentChannelId] = useState<string | null>(null)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [saving, setSaving] = useState(false)

  const channelName = integration?.meta?.channel_name as string | undefined

  function openSlackAuth() {
    setWaiting(true)
    const returnTo = encodeURIComponent(`/projects/${projectId}/setup`)
    window.open(
      `/api/integrations/slack/authorize?project_id=${projectId}&return_to=${returnTo}`,
      '_blank',
    )
  }

  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(async () => {
      await onRefresh()
    }, 2000)
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
        setCurrentChannelId(data.currentChannelId || null)
        setShowChannels(true)
      } else {
        toast.error('Failed to load channels')
      }
    } catch {
      toast.error('Failed to load channels')
    } finally {
      setLoadingChannels(false)
    }
  }

  async function selectChannel(channelId: string, name: string) {
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/slack/channels', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          channel_id: channelId,
          channel_name: name,
        }),
      })
      if (res.ok) {
        toast.success(`Channel set to #${name}`)
        setShowChannels(false)
        onRefresh()
      } else {
        toast.error('Failed to set channel')
      }
    } catch {
      toast.error('Failed to set channel')
    } finally {
      setSaving(false)
    }
  }

  return (
    <IntegrationCard
      title="Slack"
      description="Get test run reports and error alerts sent to a Slack channel."
      connected={!!integration}
      meta={
        integration
          ? `${integration.meta?.team_name || 'Workspace'}${channelName ? ` · #${channelName}` : ' · No channel selected'}`
          : undefined
      }
    >
      {!integration ? (
        waiting ? (
          <p className="text-base opacity-50">Waiting for Slack authorization... Complete the setup in the opened tab.</p>
        ) : (
          <button onClick={openSlackAuth} className="text-lg underline">
            Connect Slack →
          </button>
        )
      ) : !channelName ? (
        <div>
          {!showChannels ? (
            <button onClick={loadChannels} disabled={loadingChannels} className="text-base underline disabled:opacity-30">
              {loadingChannels ? 'Loading...' : 'Select a channel →'}
            </button>
          ) : (
            <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => selectChannel(ch.id, ch.name)}
                  disabled={saving}
                  className={`block w-full text-left px-3 py-2 rounded hover:bg-white/5 text-base ${
                    ch.id === currentChannelId ? 'opacity-100 font-medium' : 'opacity-60'
                  }`}
                >
                  #{ch.name}
                </button>
              ))}
              {channels.length === 0 && (
                <p className="text-base opacity-40 px-3 py-2">No channels found.</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-base opacity-40 underline">
          Change channel
        </button>
      )}
    </IntegrationCard>
  )
}
