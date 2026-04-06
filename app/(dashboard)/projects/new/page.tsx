'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { primaryGithubRepoFullName } from '@/lib/github-integration-config'
import type { Json } from '@/lib/supabase/types'

type IntegrationStatus = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
}

export default function NewProjectPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const existingProjectId = searchParams.get('projectId')

  const [submitting, setSubmitting] = useState(false)
  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

  // Phase 2 state
  const [projectId, setProjectId] = useState<string | null>(existingProjectId)
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const toastShown = useRef(false)

  const loadIntegrations = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/integrations`)
      if (res.ok) {
        const data = await res.json()
        setIntegrations(data.integrations || [])
      }
    } catch {
      // ignore
    } finally {
      setLoadingIntegrations(false)
    }
  }, [])

  // Load integrations when we have a projectId (from URL or after creation)
  useEffect(() => {
    if (!projectId) return
    setLoadingIntegrations(true)
    loadIntegrations(projectId)
  }, [projectId, loadIntegrations])

  // Re-fetch integrations on tab focus
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

  // Toast for OAuth callbacks
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

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, string> = {
        name,
        app_url: appUrl,
      }
      if (authEmail.trim()) body.auth_email = authEmail.trim()
      if (authPassword) body.auth_password = authPassword

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? 'Request failed'))
        return
      }
      if (data?.id) {
        setProjectId(data.id)
        // Update URL for refresh resilience
        window.history.replaceState(null, '', `/projects/new?projectId=${data.id}`)
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

  const githubIntegration = getStatus('github')
  const githubRepos =
    (githubIntegration?.meta?.repos as Array<Record<string, Json>>) || []
  const githubRepoSelected = !!primaryGithubRepoFullName(githubRepos)
  const githubComplete = !!githubIntegration && githubRepoSelected

  const handleRefresh = useCallback(() => {
    if (projectId) loadIntegrations(projectId)
  }, [projectId, loadIntegrations])

  // Phase 1: Project details form
  if (!projectId) {
    return (
      <div className="max-w-3xl mx-auto">
        <h1 className="text-5xl mb-4">Set Up Your Project</h1>
        <p className="text-xl opacity-50 mb-12">
          Create your project, then connect your data sources.
        </p>

        <form onSubmit={onCreateProject} className="space-y-10">
          <div>
            <label className="block text-xl opacity-60 mb-2">Project name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My product"
              autoComplete="off"
              className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
            />
          </div>

          <div>
            <label className="block text-xl opacity-60 mb-2">App URL</label>
            <p className="text-lg opacity-50 mb-3">The URL our QA agent will test.</p>
            <input
              type="url"
              required
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              placeholder="https://app.example.com"
              autoComplete="off"
              className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
            />
          </div>

          <div className="pt-4">
            <h2 className="text-3xl mb-3">Test Account Credentials</h2>
            <p className="text-lg opacity-50 mb-8">
              Optional: provide credentials so the QA agent can test authenticated flows.
            </p>

            <div className="space-y-8">
              <div>
                <label className="block text-xl opacity-60 mb-2">Auth email</label>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="tester@example.com"
                  autoComplete="off"
                  className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
                />
              </div>

              <div>
                <label className="block text-xl opacity-60 mb-2">Auth password</label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  autoComplete="new-password"
                  className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-8 pt-6">
            <button type="button" onClick={() => router.back()} className="text-2xl underline opacity-50 hover:opacity-100">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="text-2xl underline disabled:opacity-30">
              {submitting ? 'Creating...' : 'Create project →'}
            </button>
          </div>
        </form>
      </div>
    )
  }

  // Phase 2: Integrations
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-5xl mb-4">Connect Integrations</h1>
      <p className="text-xl opacity-50 mb-12">
        Connect your data sources so Verona can analyze your project. GitHub is required; the rest can be added later from project settings.
      </p>

      {loadingIntegrations ? (
        <p className="text-2xl opacity-40">Loading...</p>
      ) : (
        <div className="space-y-6">
          <GitHubCard projectId={projectId} integration={getStatus('github')} onRefresh={handleRefresh} />
          <PostHogCard projectId={projectId} integration={getStatus('posthog')} onRefresh={handleRefresh} />
          <SentryCard projectId={projectId} integration={getStatus('sentry')} onRefresh={handleRefresh} />
          <LangSmithCard projectId={projectId} integration={getStatus('langsmith')} onRefresh={handleRefresh} />
          <BraintrustCard projectId={projectId} integration={getStatus('braintrust')} onRefresh={handleRefresh} />
          <SlackCard projectId={projectId} integration={getStatus('slack')} onRefresh={handleRefresh} />
        </div>
      )}

      <div className="flex flex-col gap-3 pt-12 pb-8">
        <button
          type="button"
          onClick={() => {
            if (!githubComplete) return
            router.push(`/projects/${projectId}/chat`)
          }}
          disabled={!githubComplete}
          className={`text-2xl underline text-left ${!githubComplete ? 'opacity-30 cursor-not-allowed' : ''}`}
        >
          Continue to Chat →
        </button>
        {!githubComplete && (
          <p className="text-lg opacity-50">
            Connect GitHub and select a repository to continue.
          </p>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Integration Card Components                                        */
/* ------------------------------------------------------------------ */

function IntegrationCard({
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
    <div className="border rounded-lg p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h3 className="text-2xl font-medium">
            {title}
            {required && (
              <span className="ml-2 text-base font-normal text-amber-600 dark:text-amber-500">
                Required
              </span>
            )}
          </h3>
          <p className="text-lg opacity-50 mt-1">{description}</p>
          {meta && <p className="text-base opacity-50 mt-1">{meta}</p>}
        </div>
        <span className={`text-base px-3 py-1 rounded-full shrink-0 whitespace-nowrap ${connected ? 'bg-green-500/10 text-green-600' : 'opacity-40'}`}>
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
  const installPopupRef = useRef<Window | null>(null)
  const repos = (integration?.meta?.repos as Array<{ full_name: string }>) || []
  const linkedRepo = repos[0]?.full_name

  function openGitHubInstall() {
    setWaiting(true)
    const returnTo = encodeURIComponent(`/projects/new?projectId=${projectId}`)
    installPopupRef.current =
      window.open(
        `/api/integrations/github/install?project_id=${projectId}&return_to=${returnTo}`,
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
      } catch {
        // ignore polling errors
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [waiting, projectId, onRefresh])

  return (
    <IntegrationCard
      title="GitHub"
      description="Connect one repository so Verona can analyze commits and source code for QA and UI flow strategy."
      connected={!!integration}
      required
      meta={linkedRepo ? `Repository: ${linkedRepo}` : integration ? 'Select a repository below' : undefined}
    >
      {!integration ? (
        waiting ? (
          <p className="text-lg opacity-50">Waiting for GitHub authorization... Complete the installation in the opened tab.</p>
        ) : (
          <button onClick={openGitHubInstall} className="text-xl underline">
            Connect GitHub →
          </button>
        )
      ) : (
        <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />
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
        <button onClick={() => setExpanded(true)} className="text-xl underline">
          Connect PostHog →
        </button>
      )}
      {!integration && expanded && (
        <div className="space-y-4 mt-4">
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Personal API key"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={phProjectId}
            onChange={(e) => setPhProjectId(e.target.value)}
            placeholder="PostHog Project ID"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={apiHost}
            onChange={(e) => setApiHost(e.target.value)}
            placeholder="API host (optional, e.g. https://eu.posthog.com)"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey || !phProjectId} className="text-lg underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-lg opacity-50 underline">
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
        <button onClick={() => setExpanded(true)} className="text-xl underline">
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
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            placeholder="Organization slug"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={projSlug}
            onChange={(e) => setProjSlug(e.target.value)}
            placeholder="Project slug"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !authToken || !orgSlug || !projSlug} className="text-lg underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-lg opacity-50 underline">
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
        <button onClick={() => setExpanded(true)} className="text-xl underline">
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
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Project name (optional)"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-lg underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-lg opacity-50 underline">
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
        <button onClick={() => setExpanded(true)} className="text-xl underline">
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
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <input
            value={btProjectName}
            onChange={(e) => setBtProjectName(e.target.value)}
            placeholder="Project name (optional)"
            className="w-full border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <div className="flex gap-4">
            <button onClick={connect} disabled={submitting || !apiKey} className="text-lg underline disabled:opacity-30">
              {submitting ? 'Connecting...' : 'Save'}
            </button>
            <button onClick={() => setExpanded(false)} className="text-lg opacity-50 underline">
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
    const returnTo = encodeURIComponent(`/projects/new?projectId=${projectId}`)
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
          <p className="text-lg opacity-50">Waiting for Slack authorization... Complete the setup in the opened tab.</p>
        ) : (
          <button onClick={openSlackAuth} className="text-xl underline">
            Connect Slack →
          </button>
        )
      ) : !channelName ? (
        <div>
          {!showChannels ? (
            <button onClick={loadChannels} disabled={loadingChannels} className="text-lg underline disabled:opacity-30">
              {loadingChannels ? 'Loading...' : 'Select a channel →'}
            </button>
          ) : (
            <div className="mt-2 max-h-60 overflow-y-auto space-y-1">
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => selectChannel(ch.id, ch.name)}
                  disabled={saving}
                  className={`block w-full text-left px-3 py-2 rounded hover:bg-white/5 text-lg ${
                    ch.id === currentChannelId ? 'opacity-100 font-medium' : 'opacity-60'
                  }`}
                >
                  #{ch.name}
                </button>
              ))}
              {channels.length === 0 && (
                <p className="text-base opacity-50 px-3 py-2">No channels found.</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-base opacity-50 underline">
          Change channel
        </button>
      )}
    </IntegrationCard>
  )
}
