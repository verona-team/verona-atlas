'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signIn } from '@/app/actions/auth'
import { HalftoneBackground } from '@/components/landing/halftone-background'
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
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-white">
      <HalftoneBackground />

      <main className="relative z-10 flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl bg-white/90 px-10 py-12 shadow-sm backdrop-blur-sm ring-1 ring-[#1a1a1a]/[0.04]">
          <div className="mb-10 text-center">
            <h1
              className="text-3xl font-semibold tracking-tight text-[#1a1a1a] sm:text-4xl"
            >
              Welcome back
            </h1>
            <p className="mt-2 text-sm text-[#1a1a1a]/50">
              Sign in to your account to continue
            </p>
          </div>

          <form action={handleSubmit} className="space-y-5">
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
                autoComplete="current-password"
                className="h-10 w-full rounded-lg border border-[#1a1a1a]/10 bg-white px-3 text-sm text-[#1a1a1a] outline-none transition-colors placeholder:text-[#1a1a1a]/30 focus:border-[#1a1a1a]/30 focus:ring-2 focus:ring-[#1a1a1a]/5"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full rounded-lg bg-[#1a1a1a] text-sm font-medium text-white transition-colors hover:bg-[#333] disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="mt-8 text-center text-[13px] text-[#1a1a1a]/40">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors">
              Sign up
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
