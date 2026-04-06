'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { PanelPage } from '@/components/dashboard/panel-page'

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
      <PanelPage projectId={projectId} title="Settings">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </PanelPage>
    )
  }

  return (
    <PanelPage projectId={projectId} title="Settings">
      <div className="space-y-8">
        {/* Integrations */}
        <div>
          <h3 className="text-xs text-muted-foreground uppercase tracking-wider mb-4">Integrations</h3>
          <div className="space-y-3">
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
              connectUrl={`/projects/new?projectId=${projectId}`}
            >
              <MetaDetail label="Project" value={getIntegration('posthog')?.meta?.posthog_project_id} />
              <MetaDetail label="Host" value={getIntegration('posthog')?.meta?.api_host} />
            </SettingsIntegrationCard>

            <SettingsIntegrationCard
              type="sentry"
              title="Sentry"
              integration={getIntegration('sentry')}
              onDisconnect={disconnect}
              connectUrl={`/projects/new?projectId=${projectId}`}
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
              connectUrl={`/projects/new?projectId=${projectId}`}
            >
              <MetaDetail label="Project" value={getIntegration('langsmith')?.meta?.project_name} />
            </SettingsIntegrationCard>

            <SettingsIntegrationCard
              type="braintrust"
              title="Braintrust"
              integration={getIntegration('braintrust')}
              onDisconnect={disconnect}
              connectUrl={`/projects/new?projectId=${projectId}`}
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

        {/* Schedule */}
        <ScheduleSection projectId={projectId} />

        {/* Danger Zone */}
        <DeleteProjectSection projectId={projectId} projectName={project?.name || ''} />
      </div>
    </PanelPage>
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
      .catch(() => { setTimezone(detectedTz) })
      .finally(() => setLoading(false))
  }, [projectId])

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_enabled: enabled, schedule_time: time, schedule_days: days, timezone }),
      })
      if (res.ok) toast.success('Schedule updated')
      else toast.error('Failed to update schedule')
    } catch { toast.error('Failed to update schedule') } finally { setSaving(false) }
  }

  function toggleDay(day: string) {
    setDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day])
  }

  if (loading) return null

  return (
    <div>
      <h3 className="text-xs text-muted-foreground uppercase tracking-wider mb-4">Schedule</h3>
      <div className="border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">Automatic test suggestions</p>
            <p className="text-xs text-muted-foreground mt-0.5">Analyze and suggest test flows on a schedule</p>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={`w-10 h-6 rounded-full transition-colors relative ${enabled ? 'bg-green-500' : 'bg-muted'}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${enabled ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </div>

        {enabled && (
          <>
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="bg-transparent border border-border rounded px-2.5 py-1.5 text-sm outline-none" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">Days</label>
              <div className="flex gap-1.5">
                {DAYS.map((d) => (
                  <button key={d.value} onClick={() => toggleDay(d.value)} className={`px-2.5 py-1 text-xs rounded border transition-colors ${days.includes(d.value) ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1.5">Timezone</label>
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" className="w-full max-w-xs bg-transparent border-b border-border py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
            </div>
          </>
        )}

        <button onClick={save} disabled={saving} className="text-sm underline disabled:opacity-30">{saving ? 'Saving...' : 'Save schedule'}</button>
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
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium">{title}</h4>
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${connected ? 'bg-green-500/10 text-green-500' : waiting ? 'bg-yellow-500/10 text-yellow-500' : 'text-muted-foreground/50'}`}>
            {connected ? 'Active' : waiting ? 'Waiting...' : 'Not connected'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {connected ? (
            <button onClick={() => onDisconnect(integration.id, title)} className="text-xs text-muted-foreground hover:text-foreground underline">Disconnect</button>
          ) : waiting ? (
            <span className="text-xs text-muted-foreground">Complete setup in the opened tab</span>
          ) : openInNewTab ? (
            <button onClick={handleConnect} className="text-xs underline text-foreground/60 hover:text-foreground">Connect →</button>
          ) : (
            <a href={connectUrl} className="text-xs underline text-foreground/60 hover:text-foreground">Connect →</a>
          )}
        </div>
      </div>
      {connected && children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  )
}

function MetaDetail({ label, value }: { label: string; value?: unknown }) {
  if (!value) return null
  return <p>{label}: <span className="text-foreground/70">{String(value)}</span></p>
}

function GitHubDetails({ integration, projectId, onRefresh }: { integration?: IntegrationData; projectId: string; onRefresh: () => void }) {
  if (!integration) return null
  const repos = (integration.meta?.repos as Array<{ full_name: string; private: boolean }>) || []
  const linked = repos[0]?.full_name

  return (
    <div className="space-y-2">
      {linked ? (
        <p className="text-xs">Linked repository: <span className="text-foreground/80">{linked}{repos[0]?.private && <span className="ml-1 text-muted-foreground">(private)</span>}</span></p>
      ) : (
        <p className="text-xs text-amber-500/80">Choose a repository below.</p>
      )}
      <GitHubRepoPicker projectId={projectId} onSaved={onRefresh} />
    </div>
  )
}

function SlackDetails({ integration, projectId, onRefresh }: { integration?: IntegrationData; projectId: string; onRefresh: () => void }) {
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
        setShowPicker(false)
        onRefresh()
      }
    } catch { toast.error('Failed to set channel') } finally { setSaving(false) }
  }

  return (
    <div>
      {teamName && <p>Workspace: {teamName}</p>}
      {channelName ? (
        <div className="flex items-center gap-2">
          <p>Channel: #{channelName}</p>
          <button onClick={loadChannels} disabled={loadingChannels} className="text-xs underline text-muted-foreground">Change</button>
        </div>
      ) : (
        <button onClick={loadChannels} disabled={loadingChannels} className="text-xs underline mt-1">
          {loadingChannels ? 'Loading...' : 'Select a channel'}
        </button>
      )}
      {showPicker && (
        <div className="mt-2 max-h-36 overflow-y-auto border border-border rounded p-2 space-y-0.5">
          {channels.map((ch) => (
            <button key={ch.id} onClick={() => selectChannel(ch.id, ch.name)} disabled={saving} className="block w-full text-left px-2 py-1 rounded text-sm hover:bg-muted/50">#{ch.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeleteProjectSection({ projectId, projectName }: { projectId: string; projectName: string }) {
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
    } catch { toast.error('Failed to delete project') } finally { setDeleting(false) }
  }

  const nameMatches = confirmText === projectName

  return (
    <div className="border border-red-500/20 rounded-lg p-4">
      <h3 className="text-sm text-red-500/80 font-medium mb-1">Danger Zone</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Deleting a project permanently removes all data. This cannot be undone.
      </p>

      {!showConfirm ? (
        <button onClick={() => setShowConfirm(true)} className="text-xs text-red-500/80 underline hover:text-red-500">Delete this project</button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs">Type <span className="font-mono font-medium">{projectName}</span> to confirm:</p>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={projectName} autoComplete="off" autoFocus className="w-full max-w-xs border-b border-border bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/50" />
          <div className="flex gap-3">
            <button onClick={handleDelete} disabled={!nameMatches || deleting} className="text-xs text-red-500 underline disabled:opacity-30">{deleting ? 'Deleting...' : 'Permanently delete'}</button>
            <button onClick={() => { setShowConfirm(false); setConfirmText('') }} className="text-xs text-muted-foreground underline">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
