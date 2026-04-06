import Link from 'next/link'

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-end px-6 py-5 sm:px-10">
        <nav className="flex items-center gap-5">
          <Link
            href="/signup"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-border px-4 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
          >
            Log In
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6" style={{ minHeight: 'calc(100vh - 68px)' }}>
        <div className="flex flex-col items-center gap-10 -mt-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted">
            <span className="text-2xl font-semibold text-foreground">V</span>
          </div>
          <h1 className="max-w-2xl text-center text-4xl font-medium leading-[1.1] tracking-tight text-foreground sm:text-5xl">
            Autonomous QA that works.
          </h1>
          <p className="text-muted-foreground text-sm max-w-md text-center">
            AI-powered testing for modern web applications. Set up a project, connect your code, and let Verona find the bugs.
          </p>
          <Link
            href="/signup"
            className="rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Get Started
          </Link>
        </div>
      </main>
    </div>
  )
}
