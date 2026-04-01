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
      const body: Record<string, string> = {
        name,
        app_url: appUrl,
      }
      if (authEmail.trim()) body.auth_email = authEmail.trim()
      if (authPassword) body.auth_password = authPassword

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        const msg =
          typeof data.error === 'string'
            ? data.error
            : JSON.stringify(data.error ?? 'Request failed')
        toast.error(msg)
        return
      }

      if (data?.id) {
        router.push(`/projects/${data.id}`)
        router.refresh()
        return
      }

      toast.error('Invalid response from server')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          New Project
        </div>
        <div className="window-body">
          <p className="text-xs text-[#6b6555] mb-4 uppercase tracking-wider">
            Register an application for autonomous QA testing.
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-[#6b6555] uppercase tracking-wider mb-1">
                Name *
              </label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My product"
                autoComplete="off"
                className="w-full bg-[#fffef9] border-2 border-[#1a1a1a] px-3 py-1.5 text-sm text-[#1a1a1a] placeholder:text-[#b8b3a4] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/20"
              />
            </div>

            <div>
              <label className="block text-xs text-[#6b6555] uppercase tracking-wider mb-1">
                App URL *
              </label>
              <input
                type="url"
                required
                value={appUrl}
                onChange={(e) => setAppUrl(e.target.value)}
                placeholder="https://app.example.com"
                autoComplete="off"
                className="w-full bg-[#fffef9] border-2 border-[#1a1a1a] px-3 py-1.5 text-sm text-[#1a1a1a] placeholder:text-[#b8b3a4] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/20"
              />
            </div>

            <div>
              <label className="block text-xs text-[#6b6555] uppercase tracking-wider mb-1">
                Auth Email (optional)
              </label>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="tester@example.com"
                autoComplete="off"
                className="w-full bg-[#fffef9] border-2 border-[#1a1a1a] px-3 py-1.5 text-sm text-[#1a1a1a] placeholder:text-[#b8b3a4] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/20"
              />
            </div>

            <div>
              <label className="block text-xs text-[#6b6555] uppercase tracking-wider mb-1">
                Auth Password (optional)
              </label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full bg-[#fffef9] border-2 border-[#1a1a1a] px-3 py-1.5 text-sm text-[#1a1a1a] placeholder:text-[#b8b3a4] focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/20"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t-2 border-[#1a1a1a]">
              <button
                type="button"
                onClick={() => router.back()}
                className="text-xs uppercase tracking-wider border-2 border-[#1a1a1a] px-4 py-1.5 hover:bg-[#e8e4d9] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="text-xs uppercase tracking-wider border-2 border-[#1a1a1a] bg-[#1a1a1a] text-[#fffef9] px-4 py-1.5 hover:bg-[#333] disabled:opacity-50 transition-colors"
              >
                {submitting ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
