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
    <header className="flex items-center justify-between border-b px-6 py-3 text-base">
      <div className="flex items-center gap-6">
        <Link href="/projects" className="text-lg font-bold tracking-wide">
          Verona
        </Link>
        <Link
          href="/projects"
          className={isProjects ? 'underline underline-offset-4' : 'opacity-50 hover:opacity-100'}
        >
          Projects
        </Link>
      </div>
      <div className="flex items-center gap-4 text-sm opacity-50">
        <span>{orgName} / {userEmail.split('@')[0]}</span>
        <button onClick={() => signOut()} className="hover:opacity-100 underline">
          Logout
        </button>
      </div>
    </header>
  )
}
