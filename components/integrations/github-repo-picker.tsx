'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
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
  const [rows, setRows] = useState<RepoRow[]>([])
  const [choice, setChoice] = useState('')

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
      setChoice(selected?.full_name ?? '')
    } catch {
      toast.error('Could not load repositories')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    if (!choice) {
      toast.error('Select a repository')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/integrations/github/repos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, repos: [choice] }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : 'Failed to save repository')
        return
      }
      toast.success('Repository saved')
      await onSaved?.()
      await load()
    } catch {
      toast.error('Failed to save repository')
    } finally {
      setSaving(false)
    }
  }

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
        <div className="min-w-[min(100%,20rem)] space-y-1.5">
          <Label htmlFor={`github-repo-${projectId}`}>Repository</Label>
          <Select value={choice} onValueChange={(v) => setChoice(v ?? '')}>
            <SelectTrigger id={`github-repo-${projectId}`}>
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
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !choice}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
