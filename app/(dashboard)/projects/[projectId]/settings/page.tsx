'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
  const projectId = params.projectId
  const router = useRouter()

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
            connectUrl={`/api/integrations/github/install?project_id=${projectId}`}
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
            connectUrl={`/api/integrations/slack/authorize?project_id=${projectId}`}
          >
            <SlackDetails integration={getIntegration('slack')} projectId={projectId} onRefresh={loadData} />
          </SettingsIntegrationCard>
        </div>
      </div>
    </div>
  )
}

function SettingsIntegrationCard({
  type,
  title,
  integration,
  onDisconnect,
  connectUrl,
  children,
}: {
  type: string
  title: string
  integration?: IntegrationData
  onDisconnect: (id: string, name: string) => void
  connectUrl: string
  children?: React.ReactNode
}) {
  const connected = !!integration

  return (
    <div className="border rounded-lg p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-medium">{title}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? 'bg-green-500/10 text-green-600' : 'opacity-40 border'}`}>
            {connected ? 'Active' : 'Not connected'}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {connected ? (
            <button
              onClick={() => onDisconnect(integration.id, title)}
              className="text-sm opacity-40 hover:opacity-70 underline"
            >
              Disconnect
            </button>
          ) : (
            <a href={connectUrl} className="text-sm underline opacity-60 hover:opacity-100">
              Connect →
            </a>
          )}
        </div>
      </div>
      {connected && children && (
        <div className="mt-3 text-sm opacity-60">{children}</div>
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
              {r.private && <span className="ml-2 text-xs opacity-40">private</span>}
            </p>
          ))}
        </div>
      ) : (
        <p>No repos selected.</p>
      )}
      <Link
        href={`/projects/${projectId}/setup`}
        className="inline-block mt-2 text-xs underline opacity-50"
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
          <button onClick={loadChannels} disabled={loadingChannels} className="text-xs underline opacity-50">
            Change
          </button>
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-xs underline mt-1">
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
              className="block w-full text-left px-2 py-1 rounded text-sm hover:bg-white/5"
            >
              #{ch.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
