'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signIn } from '@/app/actions/auth'
import { toast } from 'sonner'

export default function LoginPage() {
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    const result = await signIn(formData)
    if (result?.error) {
      toast.error(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <Link href="/" className="font-bold text-sm tracking-widest uppercase text-foreground hover:text-phosphor-bright">
          ◆ Verona
        </Link>
        <Link
          href="/signup"
          className="text-[10px] uppercase tracking-wider text-phosphor-dim hover:text-foreground transition-colors"
        >
          [Create account]
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="window-chrome">
            <div className="window-title-bar">
              <span className="close-box" />
              System Login
            </div>
            <div className="window-body">
              <div className="mb-6 text-center">
                <p className="text-xs text-phosphor-dim uppercase tracking-wider">
                  Authenticate to continue
                </p>
              </div>

              <form action={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-xs text-phosphor-dim uppercase tracking-wider mb-1">
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    placeholder="you@company.com"
                    required
                    autoComplete="email"
                    className="w-full bg-background border border-border px-3 py-2 text-sm text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
                  />
                </div>
                <div>
                  <label htmlFor="password" className="block text-xs text-phosphor-dim uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full bg-background border border-border px-3 py-2 text-sm text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full border border-foreground bg-foreground text-background text-xs uppercase tracking-wider py-2 hover:bg-phosphor-bright disabled:opacity-50 transition-colors"
                >
                  {loading ? 'Authenticating...' : 'Sign In'}
                </button>
              </form>

              <p className="mt-6 text-center text-[10px] text-phosphor-dim uppercase tracking-wider">
                No account?{' '}
                <Link href="/signup" className="text-foreground hover:text-phosphor-bright transition-colors underline underline-offset-2">
                  Register
                </Link>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
