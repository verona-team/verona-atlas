import Link from 'next/link'
import { MetisLogo } from '@/components/landing/metis-logo'
import { HalftoneBackground } from '@/components/landing/halftone-background'
import { ExternalLink } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden" style={{ backgroundColor: '#EDE5D1' }}>
      <HalftoneBackground />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-2">
          <MetisLogo size={20} className="text-[#1a1a1a]" />
          <span className="text-[15px] font-medium tracking-tight text-[#1a1a1a]">
            Metis
          </span>
        </Link>

        <nav className="flex items-center gap-6">
          <Link
            href="/about"
            className="text-[13px] text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
          >
            About
          </Link>
          <Link
            href="/product"
            className="text-[13px] text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
          >
            Product
          </Link>
          <Link
            href="/signup"
            className="text-[13px] text-[#1a1a1a]/70 hover:text-[#1a1a1a] transition-colors"
          >
            Request Access
          </Link>
          <Link
            href="/careers"
            className="flex items-center gap-1 rounded-full border border-[#1a1a1a]/20 px-3 py-1 text-[13px] text-[#1a1a1a]/80 hover:border-[#1a1a1a]/40 hover:text-[#1a1a1a] transition-colors"
          >
            Careers
            <ExternalLink className="h-3 w-3" />
          </Link>
        </nav>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6" style={{ minHeight: 'calc(100vh - 68px)' }}>
        <div className="flex flex-col items-center gap-8 -mt-16">
          <MetisLogo size={36} className="text-[#1a1a1a]" />
          <h1
            className="max-w-xl text-center text-[2.5rem] leading-[1.15] tracking-tight text-[#1a1a1a]"
            style={{ fontFamily: 'var(--font-serif)' }}
          >
            Training agents to work
            <br />
            reliably for your customers.
          </h1>
        </div>
      </main>
    </div>
  )
}
