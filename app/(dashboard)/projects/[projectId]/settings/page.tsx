'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@/lib/workspace-context'
import { GitHubRepoPicker } from '@/components/integrations/github-repo-picker'
import { PanelPage } from '@/components/dashboard/panel-page'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

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
  const { refreshProjects } = useWorkspace()

  const [project, setProject] = useState<ProjectData | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationData[]>([])
  const [loading, setLoading] = useState(true)
  const lastIntegrationsKeyRef = useRef<string>('')

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
        const next = (intData.integrations || []) as IntegrationData[]
        const key = next
          .map((i) => `${i.id}:${i.status}:${JSON.stringify(i.meta ?? {})}`)
          .sort()
          .join('|')
        if (key !== lastIntegrationsKeyRef.current) {
          lastIntegrationsKeyRef.current = key
          setIntegrations(next)
        }
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
        <div>
          <h3 className="text-xs text-muted-foreground uppercase tracking-wider mb-4">Integrations</h3>
          <div className="space-y-3">
            <SettingsIntegrationCard
              type="github"
              title="GitHub"
              integration={getIntegration('github')}
              onDisconnect={disconnect}
              connectUrl={`/api/integrations/github/install?project_id=${projectId}&return_to=${encodeURIComponent('/auth/oauth-complete?integration=github')}`}
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
              connectUrl={`/api/integrations/slack/authorize?project_id=${projectId}&return_to=${encodeURIComponent('/auth/oauth-complete?integration=slack')}`}
              openInNewTab
              onRefresh={loadData}
            >
              <SlackDetails integration={getIntegration('slack')} projectId={projectId} onRefresh={loadData} />
            </SettingsIntegrationCard>
          </div>
        </div>

        <ScheduleSection projectId={projectId} />
        <DeleteProjectSection projectId={projectId} projectName={project?.name || ''} onDeleted={refreshProjects} />
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
      <Card size="sm" className="ring-0 border border-border">
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Automatic test suggestions</p>
              <p className="text-xs text-muted-foreground mt-0.5">Analyze and suggest test flows on a schedule</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {enabled && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-time">Time</Label>
                <Input id="schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-auto" />
              </div>
              <div className="space-y-1.5">
                <Label>Days</Label>
                <div className="flex gap-1.5">
                  {DAYS.map((d) => (
                    <Button
                      key={d.value}
                      variant={days.includes(d.value) ? 'default' : 'outline'}
                      size="xs"
                      onClick={() => toggleDay(d.value)}
                    >
                      {d.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-tz">Timezone</Label>
                <Input id="schedule-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" className="max-w-xs" />
              </div>
            </>
          )}

          <Button variant="link" size="sm" className="px-0" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save schedule'}</Button>
        </CardContent>
      </Card>
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
  const previouslyConnectedRef = useRef(connected)

  function handleConnect() {
    if (openInNewTab) {
      setWaiting(true)
      connectPopupRef.current = window.open(connectUrl, '_blank') ?? null
    }
  }

  // Fast path: the oauth-complete popup posts back on success.
  useEffect(() => {
    if (!waiting || !onRefresh) return
    const refresh = onRefresh
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { source?: string; integration?: string } | null
      if (!data || data.source !== 'verona-oauth') return
      if (data.integration !== type) return
      void refresh()
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [waiting, onRefresh, type])

  // Fallback polling.
  useEffect(() => {
    if (!waiting) return
    const refresh = onRefresh
    if (!refresh) return
    const interval = setInterval(async () => {
      if (type === 'github') {
        try {
          const projectId = connectUrl.match(/project_id=([^&]+)/)?.[1]
          if (projectId) {
            const res = await fetch(`/api/integrations/github/status?project_id=${projectId}`)
            if (res.ok) {
              const data = await res.json()
              if (data.connected) {
                await refresh()
                return
              }
            }
          }
        } catch {}
      }
      await refresh()
    }, 2000)
    return () => clearInterval(interval)
  }, [waiting, onRefresh, type, connectUrl])

  useEffect(() => {
    if (waiting && connected) {
      setWaiting(false)
      connectPopupRef.current?.close()
      connectPopupRef.current = null
      if (!previouslyConnectedRef.current) {
        toast.success(`${title} connected`)
        window.focus()
      }
    }
    previouslyConnectedRef.current = connected
  }, [waiting, connected, title])

  return (
    <Card size="sm" className="ring-0 border border-border">
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium">{title}</h4>
            <Badge
              variant={connected ? 'outline' : 'secondary'}
              className={`transition-colors duration-200 ${
                connected
                  ? 'border-green-500/30 text-green-500'
                  : waiting
                    ? 'border-border text-muted-foreground'
                    : ''
              }`}
            >
              {connected ? 'Active' : waiting ? 'Connecting…' : 'Not connected'}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            {connected ? (
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
                  Disconnect
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {title}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove the {title} integration. You can reconnect later.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => onDisconnect(integration.id, title)}>
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : waiting ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Complete setup in the opened tab
              </span>
            ) : openInNewTab ? (
              <Button variant="link" size="xs" onClick={handleConnect}>Connect →</Button>
            ) : (
              <Button variant="link" size="xs" render={<a href={connectUrl} />}>Connect →</Button>
            )}
          </div>
        </div>
        {connected && children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
      </CardContent>
    </Card>
  )
}

function MetaDetail({ label, value }: { label: string; value?: unknown }) {
  if (!value) return null
  return <p>{label}: <span className="text-foreground/70">{String(value)}</span></p>
}

function GitHubDetails({ integration, projectId, onRefresh }: { integration?: IntegrationData; projectId: string; onRefresh: () => void }) {
  if (!integration) return null
  const repo = integration.meta?.repo as
    | { full_name: string; private?: boolean | null }
    | null
    | undefined
  const linked = repo?.full_name

  return (
    <div className="space-y-2">
      {linked ? (
        <p className="text-xs">Linked repository: <span className="text-foreground/80">{linked}{repo?.private && <span className="ml-1 text-muted-foreground">(private)</span>}</span></p>
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
          <Button variant="link" size="xs" className="px-0 text-muted-foreground" onClick={loadChannels} disabled={loadingChannels}>
            Change
          </Button>
        </div>
      ) : (
        <Button variant="link" size="xs" className="px-0" onClick={loadChannels} disabled={loadingChannels}>
          {loadingChannels ? 'Loading...' : 'Select a channel'}
        </Button>
      )}
      {showPicker && (
        <div className="mt-2 max-h-36 overflow-y-auto border border-border rounded-lg p-2 space-y-0.5">
          {channels.map((ch) => (
            <Button key={ch.id} variant="ghost" size="sm" className="w-full justify-start" onClick={() => selectChannel(ch.id, ch.name)} disabled={saving}>
              #{ch.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeleteProjectSection({ projectId, projectName, onDeleted }: { projectId: string; projectName: string; onDeleted?: () => Promise<void> }) {
  const router = useRouter()
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) {
        toast.success('Project deleted')
        await onDeleted?.()
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
    <Card size="sm" className="ring-0 border border-destructive/30">
      <CardContent className="space-y-4">
        <div>
          <h3 className="text-sm text-destructive font-medium mb-1">Danger Zone</h3>
          <p className="text-xs text-muted-foreground">
            Deleting a project permanently removes all data. This cannot be undone.
          </p>
        </div>

        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
            Delete this project
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete project?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete <strong>{projectName}</strong> and all its data. Type the project name to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="px-4">
              <div className="space-y-1.5">
                <Label htmlFor="delete-confirm">Project name</Label>
                <Input
                  id="delete-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={projectName}
                  autoComplete="off"
                  autoFocus
                />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmText('')}>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={!nameMatches || deleting}>
                {deleting ? 'Deleting...' : 'Permanently delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
