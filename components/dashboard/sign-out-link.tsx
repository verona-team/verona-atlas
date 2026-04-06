'use client'

import { signOut } from '@/app/actions/auth'

export function SignOutLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => signOut()}
      className={
        className ??
        'text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline'
      }
    >
      Sign out
    </button>
  )
}
