import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Shield, Zap, Eye } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="flex flex-col items-center gap-12 px-4 py-16 text-center max-w-4xl mx-auto">
      {/* Hero */}
      <div className="flex flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          <Shield className="h-10 w-10 text-primary" />
          <h1 className="text-5xl font-bold tracking-tight">Atlas</h1>
        </div>
        <p className="text-xl text-muted-foreground max-w-2xl">
          Autonomous QA testing powered by AI. Connect your app, and Atlas finds
          bugs before your users do.
        </p>
        <div className="flex gap-4 mt-4">
          <Link href="/signup">
            <Button size="lg">Get Started</Button>
          </Link>
          <Link href="/login">
            <Button variant="outline" size="lg">Sign In</Button>
          </Link>
        </div>
      </div>

      {/* Features */}
      <div className="grid gap-8 md:grid-cols-3 w-full mt-8">
        <div className="flex flex-col items-center gap-3 p-6 rounded-lg border bg-card">
          <Eye className="h-8 w-8 text-primary" />
          <h3 className="font-semibold text-lg">AI Test Planning</h3>
          <p className="text-sm text-muted-foreground">
            Analyzes PostHog sessions and GitHub commits to identify the most
            critical flows to test.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3 p-6 rounded-lg border bg-card">
          <Zap className="h-8 w-8 text-primary" />
          <h3 className="font-semibold text-lg">Autonomous Browser Testing</h3>
          <p className="text-sm text-muted-foreground">
            Spins up isolated cloud browsers, authenticates into your app, and
            runs AI-driven test flows.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3 p-6 rounded-lg border bg-card">
          <Shield className="h-8 w-8 text-primary" />
          <h3 className="font-semibold text-lg">Detailed Reports</h3>
          <p className="text-sm text-muted-foreground">
            Get bug reports, recommended fixes, and feature suggestions delivered
            to Slack.
          </p>
        </div>
      </div>
    </div>
  )
}
