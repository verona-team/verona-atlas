'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function NewProjectPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, string> = { name, app_url: appUrl }
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
      if (data?.id) { router.push(`/projects/${data.id}`); router.refresh(); return }
      toast.error('Invalid response from server')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-md">
      <h1 className="text-lg mb-6">New Project</h1>

      <form onSubmit={onSubmit} className="space-y-4 text-sm">
        <div>
          <label className="block text-xs opacity-40 mb-1">Name</label>
          <input
            required value={name} onChange={(e) => setName(e.target.value)}
            placeholder="My product" autoComplete="off"
            className="w-full border-b bg-transparent py-1 outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-xs opacity-40 mb-1">App URL</label>
          <input
            type="url" required value={appUrl} onChange={(e) => setAppUrl(e.target.value)}
            placeholder="https://app.example.com" autoComplete="off"
            className="w-full border-b bg-transparent py-1 outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-xs opacity-40 mb-1">Auth email (optional)</label>
          <input
            type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
            placeholder="tester@example.com" autoComplete="off"
            className="w-full border-b bg-transparent py-1 outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-xs opacity-40 mb-1">Auth password (optional)</label>
          <input
            type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full border-b bg-transparent py-1 outline-none placeholder:opacity-30"
          />
        </div>

        <div className="flex gap-4 pt-4">
          <button type="button" onClick={() => router.back()} className="text-sm underline opacity-50 hover:opacity-100">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="text-sm underline disabled:opacity-30">
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
