import Link from 'next/link'

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <span className="font-bold text-sm tracking-widest uppercase text-foreground">
          ◆ Verona
        </span>
        <nav className="flex items-center gap-4">
          <Link
            href="/signup"
            className="text-[10px] uppercase tracking-wider text-phosphor-dim hover:text-foreground transition-colors"
          >
            [Register]
          </Link>
          <Link
            href="/login"
            className="text-[10px] uppercase tracking-wider border border-border px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors"
          >
            Login
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center gap-8 -mt-16">
          <div className="text-center space-y-1">
            <div className="text-6xl sm:text-8xl font-bold tracking-tight">
              ◆
            </div>
            <p className="text-[10px] text-phosphor-dim uppercase tracking-[0.3em]">
              Verona QA System
            </p>
          </div>
          <h1 className="max-w-lg text-center text-2xl sm:text-3xl tracking-wider uppercase">
            Autonomous QA
            <br />
            <span className="text-phosphor-dim">that works.</span>
          </h1>
          <div className="flex gap-3 mt-4">
            <Link
              href="/signup"
              className="text-xs uppercase tracking-wider border border-foreground bg-foreground text-background px-6 py-2 hover:bg-phosphor-bright transition-colors"
            >
              Get Started
            </Link>
            <Link
              href="/login"
              className="text-xs uppercase tracking-wider border border-border px-6 py-2 hover:bg-accent transition-colors"
            >
              Sign In
            </Link>
          </div>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-2 text-center">
        <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">
          Verona QA System v1.0 — All rights reserved
        </p>
      </footer>
    </div>
  )
}
