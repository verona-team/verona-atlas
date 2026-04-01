'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function NewProjectPage() {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')

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
        toast.error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? 'Request failed'))
        return
      }
      if (data?.id) {
        router.push(`/projects/${data.id}/setup`)
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
    <div className="max-w-3xl mx-auto">
      <h1 className="text-5xl mb-12">New Project</h1>

      <form onSubmit={onSubmit} className="space-y-10">
        <div>
          <label className="block text-xl opacity-60 mb-2">Project name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My product"
            autoComplete="off"
            className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
          />
        </div>

        <div>
          <label className="block text-xl opacity-60 mb-2">App URL</label>
          <p className="text-lg opacity-50 mb-3">The URL our QA agent will test.</p>
          <input
            type="url"
            required
            value={appUrl}
            onChange={(e) => setAppUrl(e.target.value)}
            placeholder="https://app.example.com"
            autoComplete="off"
            className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
          />
        </div>

        <div className="pt-4">
          <h2 className="text-3xl mb-3">Test Account Credentials</h2>
          <p className="text-lg opacity-50 mb-8">
            Optional: provide credentials so the QA agent can test authenticated flows.
          </p>

          <div className="space-y-8">
            <div>
              <label className="block text-xl opacity-60 mb-2">Auth email</label>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="tester@example.com"
                autoComplete="off"
                className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xl opacity-60 mb-2">Auth password</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full border-b bg-transparent py-3 text-2xl outline-none placeholder:opacity-60"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-8 pt-6">
          <button type="button" onClick={() => router.back()} className="text-2xl underline opacity-50 hover:opacity-100">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="text-2xl underline disabled:opacity-30">
            {submitting ? 'Creating...' : 'Create project →'}
          </button>
        </div>
      </form>
    </div>
  )
}
