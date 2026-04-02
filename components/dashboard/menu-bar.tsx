'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from '@/app/actions/auth'

interface MenuBarProps {
  userEmail: string
  orgName: string
}

export function MenuBar({ userEmail, orgName }: MenuBarProps) {
  const pathname = usePathname()
  const isProjects = pathname === '/projects' || pathname.startsWith('/projects/')

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 bg-muted/30 px-6 md:px-12 lg:px-16">
      <div className="flex min-w-0 items-center gap-5">
        <Link href="/projects" className="text-xl font-bold tracking-wide">
          Verona
        </Link>
        <Link
          href="/projects"
          className={`text-sm transition-opacity ${
            isProjects
              ? 'text-foreground/90'
              : 'text-muted-foreground hover:text-foreground/80'
          }`}
        >
          Projects
        </Link>
      </div>
      <div className="flex min-w-0 items-center gap-4 text-sm text-muted-foreground">
        <span className="truncate">
          {orgName} / {userEmail.split('@')[0]}
        </span>
        <button
          type="button"
          onClick={() => signOut()}
          className="shrink-0 text-foreground/70 underline-offset-4 hover:text-foreground hover:underline"
        >
          Logout
        </button>
      </div>
    </header>
  )
}
