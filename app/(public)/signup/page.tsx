'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signUp } from '@/app/actions/auth'
import { toast } from 'sonner'

export default function SignupPage() {
  const [loading, setLoading] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    const result = await signUp(formData)
    if (result?.error) {
      toast.error(result.error)
      setLoading(false)
    } else if (result?.success) {
      setConfirmEmail(result.email ?? formData.get('email') as string)
    }
  }

  if (confirmEmail) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="flex items-center px-6 py-5 sm:px-10">
          <Link href="/" className="text-sm font-semibold text-foreground">
            Verona
          </Link>
        </header>

        <main className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-sm text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-foreground/60">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
            </div>
            <h1 className="text-lg font-medium text-foreground">
              Check your email
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We sent a confirmation link to
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {confirmEmail}
            </p>
            <p className="mt-3 text-xs text-muted-foreground leading-relaxed">
              Click the link in the email to verify your account.
            </p>
            <div className="mt-6 pt-4 border-t border-border">
              <Link href="/login" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                Back to sign in
              </Link>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="text-sm font-semibold text-foreground">
          Verona
        </Link>
        <Link
          href="/login"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Sign in
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <h1 className="text-xl font-medium text-foreground">
              Create your account
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Get started with autonomous QA testing
            </p>
          </div>

          <form action={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="orgName" className="block text-xs text-muted-foreground">
                Organization Name
              </label>
              <input
                id="orgName"
                name="orgName"
                type="text"
                placeholder="Acme Inc."
                required
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-xs text-muted-foreground">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@company.com"
                required
                autoComplete="email"
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-xs text-muted-foreground">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                placeholder="••••••••"
                required
                autoComplete="new-password"
                minLength={8}
                className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:ring-1 focus:ring-ring"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 h-9 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-foreground/70 hover:text-foreground transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
