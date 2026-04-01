'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

type Step = 'details' | 'integrations'

interface IntegrationState {
  github: string
  posthog: string
  sentry: string
  langsmith: string
}

export default function NewProjectPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('details')
  const [name, setName] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)

  const [integrations, setIntegrations] = useState<IntegrationState>({
    github: '',
    posthog: '',
    sentry: '',
    langsmith: '',
  })

  async function handleCreateProject(e: React.FormEvent) {
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
      if (data?.id) {
        setProjectId(data.id)
        setStep('integrations')
        return
      }
      toast.error('Invalid response from server')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  function handleFinish() {
    if (projectId) {
      router.push(`/projects/${projectId}`)
      router.refresh()
    }
  }

  if (step === 'integrations') {
    return (
      <div className="max-w-lg">
        <h1 className="text-2xl mb-2">Connect Integrations</h1>
        <p className="text-base opacity-40 mb-8">
          Connect the services our QA agent needs to test and monitor your application. You can skip any of these and configure them later.
        </p>

        <div className="space-y-6">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-base">GitHub</span>
              <span className="text-sm opacity-30">Repository</span>
            </div>
            <p className="text-sm opacity-40 mb-2">
              Connect the GitHub repo so our agent can read code, file issues, and track changes.
            </p>
            <input
              value={integrations.github}
              onChange={(e) => setIntegrations(prev => ({ ...prev, github: e.target.value }))}
              placeholder="owner/repo"
              className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-base">PostHog</span>
              <span className="text-sm opacity-30">Analytics</span>
            </div>
            <p className="text-sm opacity-40 mb-2">
              Connect PostHog so the agent can monitor analytics events and track regressions.
            </p>
            <input
              value={integrations.posthog}
              onChange={(e) => setIntegrations(prev => ({ ...prev, posthog: e.target.value }))}
              placeholder="PostHog project API key"
              className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-base">Sentry</span>
              <span className="text-sm opacity-30">Error tracking</span>
            </div>
            <p className="text-sm opacity-40 mb-2">
              Connect Sentry so the agent can detect errors and exceptions during test runs.
            </p>
            <input
              value={integrations.sentry}
              onChange={(e) => setIntegrations(prev => ({ ...prev, sentry: e.target.value }))}
              placeholder="Sentry DSN or project slug"
              className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-base">LangSmith / Braintrust</span>
              <span className="text-sm opacity-30">LLM observability</span>
            </div>
            <p className="text-sm opacity-40 mb-2">
              Connect your LLM observability tool so the agent can trace AI calls and evaluate outputs.
            </p>
            <input
              value={integrations.langsmith}
              onChange={(e) => setIntegrations(prev => ({ ...prev, langsmith: e.target.value }))}
              placeholder="API key"
              className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
            />
          </div>
        </div>

        <div className="flex gap-6 pt-8">
          <button
            onClick={handleFinish}
            className="text-base opacity-40 hover:opacity-70 underline"
          >
            Skip for now
          </button>
          <button
            onClick={handleFinish}
            className="text-base underline"
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl mb-8">New Project</h1>

      <form onSubmit={handleCreateProject} className="space-y-5">
        <div>
          <label className="block text-sm opacity-40 mb-1">Name</label>
          <input
            required value={name} onChange={(e) => setName(e.target.value)}
            placeholder="My product" autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-sm opacity-40 mb-1">App URL</label>
          <input
            type="url" required value={appUrl} onChange={(e) => setAppUrl(e.target.value)}
            placeholder="https://app.example.com" autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-sm opacity-40 mb-1">Auth email (optional)</label>
          <input
            type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
            placeholder="tester@example.com" autoComplete="off"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>
        <div>
          <label className="block text-sm opacity-40 mb-1">Auth password (optional)</label>
          <input
            type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
            autoComplete="new-password"
            className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30"
          />
        </div>

        <div className="flex gap-6 pt-4">
          <button type="button" onClick={() => router.back()} className="text-base underline opacity-50 hover:opacity-100">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="text-base underline disabled:opacity-30">
            {submitting ? 'Creating...' : 'Next →'}
          </button>
        </div>
      </form>
    </div>
  )
}
