'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signUp } from '@/app/actions/auth'
import { MetisLogo } from '@/components/landing/metis-logo'
import { HalftoneBackground } from '@/components/landing/halftone-background'
import { toast } from 'sonner'

export default function SignupPage() {
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    const result = await signUp(formData)
    if (result?.error) {
      toast.error(result.error)
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-white">
      <HalftoneBackground />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-2">
          <MetisLogo size={20} className="text-[#1a1a1a]" />
        </Link>
        <Link
          href="/login"
          className="text-[13px] font-medium text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
        >
          Sign in
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl bg-white/90 px-10 py-12 shadow-sm backdrop-blur-sm ring-1 ring-[#1a1a1a]/[0.04]">
          <div className="mb-10 text-center">
            <h1
              className="text-3xl tracking-tight text-[#1a1a1a] sm:text-4xl"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              Create your account
            </h1>
            <p className="mt-2 text-sm text-[#1a1a1a]/50">
              Get started with autonomous QA testing
            </p>
          </div>

          <form action={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <label htmlFor="orgName" className="block text-[13px] font-medium text-[#1a1a1a]/70">
                Organization Name
              </label>
              <input
                id="orgName"
                name="orgName"
                type="text"
                placeholder="Acme Inc."
                required
                className="h-10 w-full rounded-lg border border-[#1a1a1a]/10 bg-white px-3 text-sm text-[#1a1a1a] outline-none transition-colors placeholder:text-[#1a1a1a]/30 focus:border-[#1a1a1a]/30 focus:ring-2 focus:ring-[#1a1a1a]/5"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-[13px] font-medium text-[#1a1a1a]/70">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@company.com"
                required
                autoComplete="email"
                className="h-10 w-full rounded-lg border border-[#1a1a1a]/10 bg-white px-3 text-sm text-[#1a1a1a] outline-none transition-colors placeholder:text-[#1a1a1a]/30 focus:border-[#1a1a1a]/30 focus:ring-2 focus:ring-[#1a1a1a]/5"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-[13px] font-medium text-[#1a1a1a]/70">
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
                className="h-10 w-full rounded-lg border border-[#1a1a1a]/10 bg-white px-3 text-sm text-[#1a1a1a] outline-none transition-colors placeholder:text-[#1a1a1a]/30 focus:border-[#1a1a1a]/30 focus:ring-2 focus:ring-[#1a1a1a]/5"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full rounded-lg bg-[#1a1a1a] text-sm font-medium text-white transition-colors hover:bg-[#333] disabled:opacity-50"
            >
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          <p className="mt-8 text-center text-[13px] text-[#1a1a1a]/40">
            Already have an account?{' '}
            <Link href="/login" className="text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
