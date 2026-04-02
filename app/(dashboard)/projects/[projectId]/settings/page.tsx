'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'

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
        <p className="text-2xl opacity-40">Loading...</p>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div>
        <Link href={`/projects/${projectId}/chat`} className="text-xl opacity-50 hover:opacity-80">
          ← {project?.name || 'Project'}
        </Link>
        <h1 className="text-5xl mt-3">Settings</h1>
      </div>

      <div>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-3xl">Integrations</h2>
          <Link
            href={`/projects/${projectId}/setup`}
            className="text-lg underline opacity-60 hover:opacity-100"
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

      <ScheduleSection projectId={projectId} />

      <DeleteProjectSection projectId={projectId} projectName={project?.name || ''} />
    </div>
  )
}

const DAYS = [
  { value: 'mon', label: 'Mon' },
  { value: 'tue', label: 'Tue' },
  { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' },
  { value: 'fri', label: 'Fri' },
  { value: 'sat', label: 'Sat' },
  { value: 'sun', label: 'Sun' },
] as const

function ScheduleSection({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('21:00')
  const [days, setDays] = useState<string[]>(['mon', 'tue', 'wed', 'thu', 'fri'])
  const [timezone, setTimezone] = useState('')

  useEffect(() => {
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    fetch(`/api/projects/${projectId}/schedule`)
      .then((r) => r.json())
      .then((data) => {
        setEnabled(data.schedule_enabled ?? false)
        setTime(data.schedule_time ?? '21:00')
        setDays(data.schedule_days ?? ['mon', 'tue', 'wed', 'thu', 'fri'])
        setTimezone(data.timezone || detectedTz)
      })
      .catch(() => {
        setTimezone(detectedTz)
      })
      .finally(() => setLoading(false))
  }, [projectId])

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule_enabled: enabled,
          schedule_time: time,
          schedule_days: days,
          timezone,
        }),
      })
      if (res.ok) {
        toast.success('Schedule updated')
      } else {
        toast.error('Failed to update schedule')
      }
    } catch {
      toast.error('Failed to update schedule')
    } finally {
      setSaving(false)
    }
  }

  function toggleDay(day: string) {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    )
  }

  if (loading) return null

  return (
    <div>
      <h2 className="text-2xl mb-6">Nightly Testing Schedule</h2>
      <div className="border rounded-lg p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-lg">Automatic test suggestions</p>
            <p className="text-sm opacity-40">
              Verona will analyze your project and suggest test flows on a schedule
            </p>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`w-12 h-7 rounded-full transition-colors relative ${
              enabled ? 'bg-green-500' : 'bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 w-6 h-6 rounded-full bg-white transition-transform ${
                enabled ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
        </div>

        {enabled && (
          <>
            <div>
              <label className="text-sm opacity-60 block mb-2">Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="bg-transparent border rounded px-3 py-2 text-base outline-none"
              />
            </div>

            <div>
              <label className="text-sm opacity-60 block mb-2">Days</label>
              <div className="flex gap-2">
                {DAYS.map((d) => (
                  <button
                    key={d.value}
                    onClick={() => toggleDay(d.value)}
                    className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                      days.includes(d.value)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'opacity-40 hover:opacity-60'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm opacity-60 block mb-2">Timezone</label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/New_York"
                className="w-full max-w-sm bg-transparent border-b py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>
          </>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="text-base underline disabled:opacity-30"
        >
          {saving ? 'Saving...' : 'Save schedule'}
        </button>
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
  const connectPopupRef = useRef<Window | null>(null)

  function handleConnect() {
    if (openInNewTab) {
      setWaiting(true)
      connectPopupRef.current = window.open(connectUrl, '_blank') ?? null
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
                setWaiting(false)
                toast.success(`${title} connected`)
                connectPopupRef.current?.close()
                connectPopupRef.current = null
                window.focus()
                return
              }
            }
          }
        } catch {}
      }
      await onRefresh()
    }, 3000)
    return () => clearInterval(interval)
  }, [waiting, onRefresh, type, connectUrl, title])

  useEffect(() => {
    if (!waiting || !connected || type === 'github') return
    queueMicrotask(() => {
      setWaiting(false)
      toast.success(`${title} connected`)
      connectPopupRef.current?.close()
      connectPopupRef.current = null
      window.focus()
    })
  }, [waiting, connected, title, type])

  return (
    <div className="border rounded-lg p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-medium">{title}</h3>
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
  const linked = repos[0]?.full_name

  return (
    <div className="space-y-2">
      {linked ? (
        <p className="text-base">
          Linked repository:{' '}
          <span className="opacity-90">
            {linked}
            {repos[0]?.private && <span className="ml-2 text-sm opacity-50">private</span>}
          </span>
        </p>
      ) : (
        <p className="text-base text-amber-600/90">Choose a repository below so the QA agent knows which codebase to use.</p>
      )}
      <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />
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
      <h2 className="text-3xl text-red-500/80 mb-2">Danger Zone</h2>
      <p className="text-lg opacity-50 mb-6">
        Deleting a project permanently removes all test templates, run history, results, and connected integrations. This cannot be undone.
      </p>

      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="text-lg text-red-500/80 underline hover:text-red-500"
        >
          Delete this project
        </button>
      ) : (
        <div className="space-y-4">
          <p className="text-lg">
            Type <span className="font-mono font-medium">{projectName}</span> to confirm:
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={projectName}
            autoComplete="off"
            autoFocus
            className="w-full max-w-sm border-b bg-transparent py-2 text-lg outline-none placeholder:opacity-60"
          />
          <div className="flex gap-4">
            <button
              onClick={handleDelete}
              disabled={!nameMatches || deleting}
              className="text-lg text-red-500 underline disabled:opacity-30 disabled:no-underline"
            >
              {deleting ? 'Deleting...' : 'Permanently delete project'}
            </button>
            <button
              onClick={() => { setShowConfirm(false); setConfirmText('') }}
              className="text-lg opacity-50 underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
