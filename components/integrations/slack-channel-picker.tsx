'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { SearchablePicker } from '@/components/ui/searchable-picker'
import { Label } from '@/components/ui/label'

type Channel = { id: string; name: string }

type Props = {
  projectId: string
  /** The currently-saved channel id, if any. */
  currentChannelId?: string
  /** Whether to auto-select a default channel when none is currently set. */
  autoDefault?: boolean
  onSaved?: () => void | Promise<void>
}

export function SlackChannelPicker({
  projectId,
  currentChannelId,
  autoDefault = false,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(true)
  const [channels, setChannels] = useState<Channel[]>([])
  const [choice, setChoice] = useState(currentChannelId || '')
  const [savedChoice, setSavedChoice] = useState(currentChannelId || '')
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const requestIdRef = useRef(0)
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoDefaultAttemptedRef = useRef(false)

  const save = useCallback(
    async (channelId: string, channelName: string, { silent = false }: { silent?: boolean } = {}) => {
      const previousSaved = savedChoice
      const reqId = ++requestIdRef.current

      setChoice(channelId)
      setSaving(true)
      setJustSaved(false)

      try {
        const res = await fetch('/api/integrations/slack/channels', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            channel_id: channelId,
            channel_name: channelName,
          }),
        })

        if (requestIdRef.current !== reqId) return false

        if (!res.ok) {
          if (!silent) toast.error('Failed to save channel')
          setChoice(previousSaved)
          return false
        }

        setSavedChoice(channelId)
        await onSaved?.()

        if (requestIdRef.current !== reqId) return true

        setJustSaved(true)
        if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
        savedFlashTimerRef.current = setTimeout(() => setJustSaved(false), 1500)
        return true
      } catch {
        if (requestIdRef.current !== reqId) return false
        if (!silent) toast.error('Failed to save channel')
        setChoice(previousSaved)
        return false
      } finally {
        if (requestIdRef.current === reqId) setSaving(false)
      }
    },
    [projectId, savedChoice, onSaved],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/integrations/slack/channels?project_id=${projectId}`)
      if (!res.ok) {
        toast.error('Failed to load channels')
        return
      }
      const data = await res.json()
      const list: Channel[] = data.channels || []
      setChannels(list)

      const serverChannelId = (data.currentChannelId as string | null) || ''
      if (serverChannelId) {
        setChoice(serverChannelId)
        setSavedChoice(serverChannelId)
      } else if (autoDefault && !autoDefaultAttemptedRef.current && list.length > 0) {
        autoDefaultAttemptedRef.current = true
        const preferred =
          list.find((c) => c.name === 'general') ??
          list.find((c) => c.name === 'random') ??
          list[0]
        void save(preferred.id, preferred.name, { silent: true })
      }
    } catch {
      toast.error('Failed to load channels')
    } finally {
      setLoading(false)
    }
  }, [projectId, autoDefault, save])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
    }
  }, [])

  async function handleChange(next: string) {
    if (!next || next === savedChoice) return
    const match = channels.find((c) => c.id === next)
    if (!match) return
    await save(match.id, match.name)
  }

  if (loading && channels.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading channels…</p>
  }

  if (channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No channels found. Invite the bot to a channel in Slack and try again.
      </p>
    )
  }

  const items = channels.map((c) => ({
    value: c.id,
    label: `#${c.name}`,
  }))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={`slack-channel-${projectId}`} className="text-xs">
          Channel
        </Label>
        <div className="flex h-4 items-center gap-1.5 text-xs text-muted-foreground transition-opacity">
          {saving ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>Saving…</span>
            </>
          ) : justSaved ? (
            <>
              <Check className="size-3 text-green-600" />
              <span>Saved</span>
            </>
          ) : null}
        </div>
      </div>
      <SearchablePicker
        id={`slack-channel-${projectId}`}
        value={choice}
        onChange={(v) => void handleChange(v)}
        items={items}
        placeholder="Select a channel…"
        searchPlaceholder="Search channels..."
        emptyText="No channels found."
      />
    </div>
  )
}
