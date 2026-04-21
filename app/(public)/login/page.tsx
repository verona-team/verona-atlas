'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signIn } from '@/app/actions/auth'
import { HalftoneBackground } from '@/components/landing/halftone-background'
import { toast } from 'sonner'
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

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
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <HalftoneBackground />

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-10">
        <Card className="w-full max-w-lg gap-6 py-7 sm:py-9">
          <CardHeader className="gap-2 px-6 text-center sm:px-10">
            <CardTitle className="text-3xl font-normal tracking-tight sm:text-4xl">
              Welcome back
            </CardTitle>
            <CardDescription>
              Sign in to your account to continue
            </CardDescription>
          </CardHeader>

          <CardContent className="px-6 sm:px-10">
            <form action={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
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
                  autoComplete="current-password"
                  className="h-11 px-3"
                />
              </div>

              <Button type="submit" disabled={loading} className="h-11 w-full">
                {loading ? 'Signing in...' : 'Sign In'}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="justify-center px-6 py-5 sm:px-10">
            <p className="text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="text-foreground hover:underline transition-colors">
                Sign up
              </Link>
            </p>
          </CardFooter>
        </Card>
      </main>
    </div>
  )
}
