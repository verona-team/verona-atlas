import Link from 'next/link'
import { InteractiveCube } from '@/components/landing/interactive-cube'

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-white" style={{ fontFamily: 'var(--font-inter)' }}>
      <header className="relative z-10 flex items-center justify-end px-6 py-5 sm:px-10">
        <nav className="flex items-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-[#1a1a1a] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#333]"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-[#1a1a1a]/15 px-5 py-2.5 text-sm font-medium text-[#1a1a1a] transition-colors hover:bg-[#f5f5f5]"
          >
            Log In
          </Link>
        </nav>
      </header>

      <main className="relative z-10 flex flex-col items-center justify-center px-6" style={{ minHeight: 'calc(100vh - 76px)' }}>
        <div className="flex flex-col items-center gap-10 -mt-12">
          <InteractiveCube size={220} />
          <h1
            className="max-w-3xl text-center text-5xl font-bold leading-[1.1] tracking-tight text-[#1a1a1a] sm:text-6xl md:text-7xl"
            style={{ fontFamily: 'var(--font-inter)' }}
          >
            Autonomous QA that works.
          </h1>
        </div>
      </main>
    </div>
  )
}
