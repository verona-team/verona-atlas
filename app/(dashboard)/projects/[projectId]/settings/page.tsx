'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

type IntegrationData = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type ProjectData = {
  id: string
  name: string
}

export default function ProjectSettingsPage() {
  const params = useParams<{ projectId: string }>()
  const searchParams = useSearchParams()
  const projectId = params.projectId
  const router = useRouter()
  const toastShown = useRef(false)

  const [project, setProject] = useState<ProjectData | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationData[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    try {
      const [projRes, intRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/projects/${projectId}/integrations`),
      ])

      if (projRes.ok) {
        const projData = await projRes.json()
        setProject(projData)
      }
      if (intRes.ok) {
        const intData = await intRes.json()
        setIntegrations(intData.integrations || [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

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
        loadData()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', loadData)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', loadData)
    }
  }, [loadData])

  const getIntegration = (type: string) =>
    integrations.find((i) => i.type === type && i.status === 'active')

  async function disconnect(integrationId: string, typeName: string) {
    if (!confirm(`Disconnect ${typeName}? You can reconnect later.`)) return
    try {
      const res = await fetch(`/api/integrations/${integrationId}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(`${typeName} disconnected`)
        loadData()
      } else {
        toast.error('Failed to disconnect')
      }
    } catch {
      toast.error('Failed to disconnect')
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-xl opacity-40">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div>
        <Link href={`/projects/${projectId}`} className="text-lg opacity-50 hover:opacity-80">
          ← {project?.name || 'Project'}
        </Link>
        <h1 className="text-4xl mt-3">Settings</h1>
      </div>

      <div>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl">Integrations</h2>
          <Link
            href={`/projects/${projectId}/setup`}
            className="text-base underline opacity-60 hover:opacity-100"
          >
            Add integration →
          </Link>
        </div>

        <div className="space-y-4">
          <SettingsIntegrationCard
            type="github"
            title="GitHub"
            integration={getIntegration('github')}
            onDisconnect={disconnect}
            connectUrl={`/api/integrations/github/install?project_id=${projectId}&return_to=${encodeURIComponent(`/projects/${projectId}/settings`)}`}
            openInNewTab
            onRefresh={loadData}
          >
            <GitHubDetails integration={getIntegration('github')} projectId={projectId} onRefresh={loadData} />
          </SettingsIntegrationCard>

          <SettingsIntegrationCard
            type="posthog"
            title="PostHog"
            integration={getIntegration('posthog')}
            onDisconnect={disconnect}
            connectUrl={`/projects/${projectId}/setup`}
          >
            <MetaDetail label="Project" value={getIntegration('posthog')?.meta?.posthog_project_id} />
            <MetaDetail label="Host" value={getIntegration('posthog')?.meta?.api_host} />
          </SettingsIntegrationCard>

          <SettingsIntegrationCard
            type="sentry"
            title="Sentry"
            integration={getIntegration('sentry')}
            onDisconnect={disconnect}
            connectUrl={`/projects/${projectId}/setup`}
          >
            <MetaDetail
              label="Project"
              value={
                getIntegration('sentry')?.meta
                  ? `${getIntegration('sentry')!.meta.organization_slug}/${getIntegration('sentry')!.meta.project_slug}`
                  : undefined
              }
            />
          </SettingsIntegrationCard>

          <SettingsIntegrationCard
            type="langsmith"
            title="LangSmith"
            integration={getIntegration('langsmith')}
            onDisconnect={disconnect}
            connectUrl={`/projects/${projectId}/setup`}
          >
            <MetaDetail label="Project" value={getIntegration('langsmith')?.meta?.project_name} />
          </SettingsIntegrationCard>

          <SettingsIntegrationCard
            type="braintrust"
            title="Braintrust"
            integration={getIntegration('braintrust')}
            onDisconnect={disconnect}
            connectUrl={`/projects/${projectId}/setup`}
          >
            <MetaDetail label="Project" value={getIntegration('braintrust')?.meta?.project_name} />
          </SettingsIntegrationCard>

          <SettingsIntegrationCard
            type="slack"
            title="Slack"
            integration={getIntegration('slack')}
            onDisconnect={disconnect}
            connectUrl={`/api/integrations/slack/authorize?project_id=${projectId}&return_to=${encodeURIComponent(`/projects/${projectId}/settings`)}`}
            openInNewTab
            onRefresh={loadData}
          >
            <SlackDetails integration={getIntegration('slack')} projectId={projectId} onRefresh={loadData} />
          </SettingsIntegrationCard>
        </div>
      </div>

      <DeleteProjectSection projectId={projectId} projectName={project?.name || ''} />
    </div>
  )
}

function SettingsIntegrationCard({
  type,
  title,
  integration,
  onDisconnect,
  connectUrl,
  openInNewTab,
  onRefresh,
  children,
}: {
  type: string
  title: string
  integration?: IntegrationData
  onDisconnect: (id: string, name: string) => void
  connectUrl: string
  openInNewTab?: boolean
  onRefresh?: () => Promise<void> | void
  children?: React.ReactNode
}) {
  const connected = !!integration
  const [waiting, setWaiting] = useState(false)

  function handleConnect() {
    if (openInNewTab) {
      setWaiting(true)
      window.open(connectUrl, '_blank')
    }
  }

  useEffect(() => {
    if (!waiting || !onRefresh) return
    const interval = setInterval(async () => {
      if (type === 'github') {
        try {
          const projectId = connectUrl.match(/project_id=([^&]+)/)?.[1]
          if (projectId) {
            const res = await fetch(`/api/integrations/github/status?project_id=${projectId}`)
            if (res.ok) {
              const data = await res.json()
              if (data.connected) {
                await onRefresh()
                return
              }
            }
          }
        } catch {}
      }
      await onRefresh()
    }, 3000)
    return () => clearInterval(interval)
  }, [waiting, onRefresh, type, connectUrl])

  useEffect(() => {
    if (waiting && connected) {
      setWaiting(false)
      toast.success(`${title} connected`)
    }
  }, [waiting, connected, title])

  return (
    <div className="border rounded-lg p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-medium">{title}</h3>
          <span className={`text-sm px-2 py-0.5 rounded-full ${connected ? 'bg-green-500/10 text-green-600' : waiting ? 'bg-yellow-500/10 text-yellow-600' : 'opacity-40 border'}`}>
            {connected ? 'Active' : waiting ? 'Waiting...' : 'Not connected'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {connected ? (
            <button
              onClick={() => onDisconnect(integration.id, title)}
              className="text-base opacity-40 hover:opacity-70 underline"
            >
              Disconnect
            </button>
          ) : waiting ? (
            <span className="text-base opacity-40">Complete setup in the opened tab</span>
          ) : openInNewTab ? (
            <button onClick={handleConnect} className="text-base underline opacity-60 hover:opacity-100">
              Connect →
            </button>
          ) : (
            <a href={connectUrl} className="text-base underline opacity-60 hover:opacity-100">
              Connect →
            </a>
          )}
        </div>
      </div>
      {connected && children && (
        <div className="mt-3 text-base opacity-60">{children}</div>
      )}
    </div>
  )
}

function MetaDetail({ label, value }: { label: string; value?: unknown }) {
  if (!value) return null
  return (
    <p>
      {label}: <span className="opacity-80">{String(value)}</span>
    </p>
  )
}

function GitHubDetails({
  integration,
  projectId,
  onRefresh,
}: {
  integration?: IntegrationData
  projectId: string
  onRefresh: () => void
}) {
  if (!integration) return null
  const repos = (integration.meta?.repos as Array<{ full_name: string; private: boolean }>) || []

  return (
    <div>
      {repos.length > 0 ? (
        <div className="space-y-1">
          {repos.map((r) => (
            <p key={r.full_name}>
              {r.full_name}
              {r.private && <span className="ml-2 text-sm opacity-40">private</span>}
            </p>
          ))}
        </div>
      ) : (
        <p>No repos selected.</p>
      )}
      <Link
        href={`/projects/${projectId}/setup`}
        className="inline-block mt-2 text-sm underline opacity-50"
      >
        Manage repos
      </Link>
    </div>
  )
}

function SlackDetails({
  integration,
  projectId,
  onRefresh,
}: {
  integration?: IntegrationData
  projectId: string
  onRefresh: () => void
}) {
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([])
  const [showPicker, setShowPicker] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [saving, setSaving] = useState(false)

  if (!integration) return null

  const teamName = integration.meta?.team_name as string
  const channelName = integration.meta?.channel_name as string

  async function loadChannels() {
    setLoadingChannels(true)
    try {
      const res = await fetch(`/api/integrations/slack/channels?project_id=${projectId}`)
      if (res.ok) {
        const data = await res.json()
        setChannels(data.channels || [])
        setShowPicker(true)
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
        body: JSON.stringify({ project_id: projectId, channel_id: channelId, channel_name: name }),
      })
      if (res.ok) {
        toast.success(`Channel set to #${name}`)
        setShowPicker(false)
        onRefresh()
      }
    } catch {
      toast.error('Failed to set channel')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {teamName && <p>Workspace: {teamName}</p>}
      {channelName ? (
        <div className="flex items-center gap-2">
          <p>Channel: #{channelName}</p>
          <button onClick={loadChannels} disabled={loadingChannels} className="text-sm underline opacity-50">
            Change
          </button>
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-sm underline mt-1">
          {loadingChannels ? 'Loading...' : 'Select a channel'}
        </button>
      )}
      {showPicker && (
        <div className="mt-2 max-h-48 overflow-y-auto border rounded p-2 space-y-1">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => selectChannel(ch.id, ch.name)}
              disabled={saving}
              className="block w-full text-left px-2 py-1 rounded text-base hover:bg-white/5"
            >
              #{ch.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeleteProjectSection({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const router = useRouter()
  const [confirmText, setConfirmText] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) {
        toast.success('Project deleted')
        router.push('/projects')
        router.refresh()
      } else {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Failed to delete project')
      }
    } catch {
      toast.error('Failed to delete project')
    } finally {
      setDeleting(false)
    }
  }

  const nameMatches = confirmText === projectName

  return (
    <div className="border border-red-500/20 rounded-lg p-6 mt-4">
      <h2 className="text-2xl text-red-500/80 mb-2">Danger Zone</h2>
      <p className="text-base opacity-50 mb-6">
        Deleting a project permanently removes all test templates, run history, results, and connected integrations. This cannot be undone.
      </p>

      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="text-base text-red-500/80 underline hover:text-red-500"
        >
          Delete this project
        </button>
      ) : (
        <div className="space-y-4">
          <p className="text-base">
            Type <span className="font-mono font-medium">{projectName}</span> to confirm:
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={projectName}
            autoComplete="off"
            autoFocus
            className="w-full max-w-sm border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
          <div className="flex gap-4">
            <button
              onClick={handleDelete}
              disabled={!nameMatches || deleting}
              className="text-base text-red-500 underline disabled:opacity-30 disabled:no-underline"
            >
              {deleting ? 'Deleting...' : 'Permanently delete project'}
            </button>
            <button
              onClick={() => { setShowConfirm(false); setConfirmText('') }}
              className="text-base opacity-50 underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
