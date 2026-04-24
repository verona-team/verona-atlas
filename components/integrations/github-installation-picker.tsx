'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type Installation = {
  id: number
  account_login: string
  account_type: string
}

/**
 * Installation picker surfaced when the OAuth callback finds the
 * authenticated GitHub user with more than one reachable
 * installation (e.g. personal account + work org). The callback
 * can't guess which installation belongs to this specific Verona
 * project, so we ask the user. Without this, multi-installation
 * users would see the bug's original spinning-forever UI.
 *
 * The picker reads the user's installations from the
 * `/api/integrations/github/installations` endpoint (backed by the
 * OAuth token stored during the callback round trip) and POSTs the
 * chosen `installation_id` to
 * `/api/integrations/github/link-installation`, which cross-checks
 * ownership before writing the integrations row.
 */
export function GitHubInstallationPicker({
  open,
  projectId,
  onOpenChange,
  onLinked,
}: {
  open: boolean
  projectId: string
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}) {
  const [installations, setInstallations] = useState<Installation[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/integrations/github/installations')
        const data = (await res.json()) as
          | { installations: Installation[] }
          | { error: string }
        if (cancelled) return
        if (!res.ok || 'error' in data) {
          setError('error' in data ? data.error : 'Failed to load installations')
          setInstallations([])
          return
        }
        setInstallations(data.installations)
        if (data.installations.length === 1) setSelected(data.installations[0].id)
      } catch {
        if (!cancelled) setError('Failed to load installations')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open])

  async function link() {
    if (selected === null) return
    setLinking(true)
    try {
      const res = await fetch('/api/integrations/github/link-installation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, installation_id: selected }),
      })
      const data = (await res.json()) as { success?: true; error?: string }
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Failed to link installation')
        return
      }
      toast.success('GitHub connected')
      onOpenChange(false)
      onLinked()
    } catch {
      toast.error('Failed to link installation')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pick a GitHub account</DialogTitle>
          <DialogDescription>
            The Verona GitHub App is installed on multiple accounts. Choose
            which one to use for this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading installations…
            </div>
          )}
          {!loading && error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          {!loading &&
            !error &&
            installations &&
            installations.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No installations found. Install the Verona app on a GitHub
                account first.
              </p>
            )}
          {!loading &&
            installations &&
            installations.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => setSelected(i.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected === i.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <div className="font-medium">@{i.account_login}</div>
                <div className="text-xs text-muted-foreground">
                  {i.account_type}
                </div>
              </button>
            ))}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={linking}
          >
            Cancel
          </Button>
          <Button
            onClick={link}
            disabled={linking || selected === null || loading}
          >
            {linking ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
