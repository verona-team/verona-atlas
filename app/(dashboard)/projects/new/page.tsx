'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function NewProjectPage() {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [githubRepo, setGithubRepo] = useState('')

  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [posthogKey, setPosthogKey] = useState('')
  const [sentryDsn, setSentryDsn] = useState('')
  const [langsmithKey, setLangsmithKey] = useState('')

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const body: Record<string, string> = {
        name,
        app_url: appUrl,
        github_repo: githubRepo,
      }
      if (authEmail.trim()) body.auth_email = authEmail.trim()
      if (authPassword) body.auth_password = authPassword
      if (posthogKey.trim()) body.posthog_key = posthogKey.trim()
      if (sentryDsn.trim()) body.sentry_dsn = sentryDsn.trim()
      if (langsmithKey.trim()) body.langsmith_key = langsmithKey.trim()

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
    <div className="max-w-lg">
      <h1 className="text-2xl mb-8">New Project</h1>

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Required fields */}
        <div>
          <label className="block text-sm opacity-40 mb-1">Project name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My product"
            autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>

        <div>
          <label className="block text-sm opacity-40 mb-1">App URL</label>
          <p className="text-sm opacity-30 mb-2">The URL our QA agent will test.</p>
          <input
            type="url"
            required
            value={appUrl}
            onChange={(e) => setAppUrl(e.target.value)}
            placeholder="https://app.example.com"
            autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>

        <div>
          <label className="block text-sm opacity-40 mb-1">GitHub repository</label>
          <p className="text-sm opacity-30 mb-2">So our agent can read code, file issues, and track changes.</p>
          <input
            required
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            placeholder="owner/repo"
            autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>

        {/* Optional integrations */}
        <div className="pt-4">
          <p className="text-sm opacity-30 mb-6">Optional — connect these so the QA agent can monitor more signals. You can configure them later from project settings.</p>

          <div className="space-y-5">
            <div>
              <label className="block text-sm opacity-40 mb-1">Auth email</label>
              <p className="text-sm opacity-30 mb-2">Test account credentials for authenticated flows.</p>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="tester@example.com"
                autoComplete="off"
                className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>

            <div>
              <label className="block text-sm opacity-40 mb-1">Auth password</label>
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>

            <div>
              <label className="block text-sm opacity-40 mb-1">PostHog</label>
              <p className="text-sm opacity-30 mb-2">Monitor analytics events and track regressions.</p>
              <input
                value={posthogKey}
                onChange={(e) => setPosthogKey(e.target.value)}
                placeholder="Project API key"
                autoComplete="off"
                className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>

            <div>
              <label className="block text-sm opacity-40 mb-1">Sentry</label>
              <p className="text-sm opacity-30 mb-2">Detect errors and exceptions during test runs.</p>
              <input
                value={sentryDsn}
                onChange={(e) => setSentryDsn(e.target.value)}
                placeholder="DSN or project slug"
                autoComplete="off"
                className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>

            <div>
              <label className="block text-sm opacity-40 mb-1">LangSmith / Braintrust</label>
              <p className="text-sm opacity-30 mb-2">Trace AI calls and evaluate LLM outputs.</p>
              <input
                value={langsmithKey}
                onChange={(e) => setLangsmithKey(e.target.value)}
                placeholder="API key"
                autoComplete="off"
                className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-6 pt-4">
          <button type="button" onClick={() => router.back()} className="text-base underline opacity-50 hover:opacity-100">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="text-base underline disabled:opacity-30">
            {submitting ? 'Creating...' : 'Create project'}
          </button>
        </div>
      </form>
    </div>
  )
}
