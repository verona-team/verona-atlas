'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { signUp } from '@/app/actions/auth'
import { HalftoneBackground } from '@/components/landing/halftone-background'
import { toast } from 'sonner'
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
export default function SignupPage() {
  const [loading, setLoading] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    const result = await signUp(formData)
    if (result?.error) {
      toast.error(result.error)
      setLoading(false)
    } else if (result?.success) {
      setConfirmEmail(result.email ?? formData.get('email') as string)
    }
  }

  if (confirmEmail) {
    return (
      <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
        <HalftoneBackground />

        <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-10">
          <Card className="w-full max-w-lg gap-6 py-7 text-center sm:py-9">
            <CardHeader className="gap-2 px-6 sm:px-10">
              <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
              </div>
              <CardTitle className="text-2xl font-normal tracking-tight sm:text-3xl">
                Check your email
              </CardTitle>
              <CardDescription>
                We sent a confirmation link to
              </CardDescription>
              <p className="text-sm font-medium text-foreground mt-1">
                {confirmEmail}
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Click the link in the email to verify your account. If you don&apos;t see it, check your spam folder.
              </p>
            </CardHeader>
            <CardFooter className="justify-center px-6 py-5 sm:px-10">
              <Link
                href="/login"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back to sign in
              </Link>
            </CardFooter>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <HalftoneBackground />

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-10">
        <Card className="w-full max-w-lg gap-6 py-7 sm:py-9">
          <CardHeader className="gap-2 px-6 text-center sm:px-10">
            <CardTitle className="text-3xl font-normal tracking-tight sm:text-4xl">
              Create your account
            </CardTitle>
            <CardDescription>
              Get started with autonomous QA testing
            </CardDescription>
          </CardHeader>

          <CardContent className="px-6 sm:px-10">
            <form action={handleSubmit} className="space-y-5" aria-busy={loading}>
              <div className="space-y-2">
                <Label htmlFor="orgName">Organization Name</Label>
                <Input
                  id="orgName"
                  name="orgName"
                  type="text"
                  placeholder="Acme Inc."
                  required
                  disabled={loading}
                  className="h-11 px-3"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                  disabled={loading}
                  className="h-11 px-3"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="••••••••"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  disabled={loading}
                  className="h-11 px-3"
                />
              </div>

              <Button type="submit" disabled={loading} className="h-11 w-full">
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Creating account…
                  </>
                ) : (
                  'Create Account'
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="justify-center px-6 py-5 sm:px-10">
            <p className="text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link href="/login" className="text-foreground hover:underline transition-colors">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </Card>
      </main>
    </div>
  )
}
