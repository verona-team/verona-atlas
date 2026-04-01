import Link from 'next/link'
import { MetisLogo } from '@/components/landing/metis-logo'
import { HalftoneBackground } from '@/components/landing/halftone-background'

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-white" style={{ fontFamily: 'var(--font-inter)' }}>
      <HalftoneBackground />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-2.5">
          <MetisLogo size={26} className="text-[#1a1a1a]" />
          <span className="text-lg font-medium tracking-tight text-[#1a1a1a]">
            Verona
          </span>
        </Link>

        <nav className="flex items-center gap-5">
          <Link
            href="/signup"
            className="text-[15px] text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="text-[15px] text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
          >
            Log In
          </Link>
        </nav>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6" style={{ minHeight: 'calc(100vh - 68px)' }}>
        <div className="flex flex-col items-center gap-8 -mt-16">
          <MetisLogo size={36} className="text-[#1a1a1a]" />
          <h1
            className="max-w-xl text-center text-[2.5rem] font-bold leading-[1.15] tracking-tight text-[#1a1a1a]"
            style={{ fontFamily: 'var(--font-inter)' }}
          >
            Autonomous QA that works.
          </h1>
        </div>
      </main>
    </div>
  )
}
