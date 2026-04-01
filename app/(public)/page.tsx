import Link from 'next/link'
import { MetisLogo } from '@/components/landing/metis-logo'
import { HalftoneBackground } from '@/components/landing/halftone-background'

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden" style={{ backgroundColor: '#EDE5D1' }}>
      <HalftoneBackground />

      <header className="relative z-10 flex items-center justify-end px-6 py-5 sm:px-10">
        <nav className="flex items-center gap-5">
          <Link
            href="/signup"
            className="text-[15px] font-medium text-[#1a1a1a] hover:text-[#1a1a1a]/70 transition-colors"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-[#1a1a1a]/30 px-4 py-1.5 text-[15px] font-medium text-[#1a1a1a] hover:border-[#1a1a1a]/50 transition-colors"
          >
            Log In
          </Link>
        </nav>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6" style={{ minHeight: 'calc(100vh - 68px)' }}>
        <div className="flex flex-col items-center gap-8 -mt-16">
          <MetisLogo size={36} className="text-[#1a1a1a]" />
          <h1
            className="max-w-2xl text-center text-5xl leading-[1.1] tracking-tight text-[#1a1a1a] sm:text-6xl"
            style={{ fontFamily: 'var(--font-serif)' }}
          >
            Autonomous QA that works.
          </h1>
        </div>
      </main>
    </div>
  )
}
