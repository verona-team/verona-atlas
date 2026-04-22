'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'

type RepoRow = {
  full_name: string
  private: boolean
  default_branch: string
  selected: boolean
}

type Props = {
  projectId: string
  onSaved?: () => void | Promise<void>
}

export function GitHubRepoPicker({ projectId, onSaved }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [rows, setRows] = useState<RepoRow[]>([])
  const [choice, setChoice] = useState('')
  const [savedChoice, setSavedChoice] = useState('')

  // Monotonic request id — lets a later selection supersede an earlier in-flight PATCH.
  const requestIdRef = useRef(0)
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/integrations/github/repos?project_id=${projectId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(typeof data.error === 'string' ? data.error : 'Could not load repositories')
        return
      }
      const data = await res.json()
      const list = (data.repos || []) as RepoRow[]
      setRows(list)
      const selected = list.find((r) => r.selected)
      const initial = selected?.full_name ?? ''
      setChoice(initial)
      setSavedChoice(initial)
    } catch {
      toast.error('Could not load repositories')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
    }
  }, [])

  const handleChange = useCallback(
    async (next: string) => {
      if (!next || next === savedChoice) {
        setChoice(next)
        return
      }

      const previousSaved = savedChoice
      const reqId = ++requestIdRef.current

      setChoice(next)
      setSaving(true)
      setJustSaved(false)

      try {
        const res = await fetch('/api/integrations/github/repos', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, repo_full_name: next }),
        })
        const data = await res.json().catch(() => ({}))

        if (requestIdRef.current !== reqId) return

        if (!res.ok) {
          toast.error(typeof data.error === 'string' ? data.error : 'Failed to save repository')
          setChoice(previousSaved)
          return
        }

        setSavedChoice(next)
        await onSaved?.()

        if (requestIdRef.current !== reqId) return
        setJustSaved(true)
        if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current)
        savedFlashTimerRef.current = setTimeout(() => setJustSaved(false), 1500)
      } catch {
        if (requestIdRef.current !== reqId) return
        toast.error('Failed to save repository')
        setChoice(previousSaved)
      } finally {
        if (requestIdRef.current === reqId) setSaving(false)
      }
    },
    [projectId, savedChoice, onSaved],
  )

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading repositories…</p>
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No repositories are available for this GitHub App installation. Add repositories to the installation on
        GitHub and try again.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pick the single repository Verona should use for code context, commits, and test planning. Each project is
        scoped to one codebase.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={`github-repo-${projectId}`}>Repository</Label>
          <Select value={choice} onValueChange={(v) => void handleChange(v ?? '')}>
            <SelectTrigger id={`github-repo-${projectId}`} className="w-full">
              <SelectValue placeholder="Select a repository…" />
            </SelectTrigger>
            <SelectContent>
              {rows.map((r) => (
                <SelectItem key={r.full_name} value={r.full_name}>
                  {r.full_name}{r.private ? ' (private)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-9 items-center gap-1.5 text-xs text-muted-foreground min-w-[72px] transition-opacity">
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
    </div>
  )
}
