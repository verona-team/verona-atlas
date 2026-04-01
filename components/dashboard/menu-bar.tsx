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
    <header className="flex items-center justify-between border-b px-8 py-4 md:px-16 lg:px-24">
      <div className="flex items-center gap-8">
        <Link href="/projects" className="text-2xl font-bold tracking-wide">
          Verona
        </Link>
        <Link
          href="/projects"
          className={`text-xl ${isProjects ? 'underline underline-offset-4' : 'opacity-60 hover:opacity-100'}`}
        >
          Projects
        </Link>
      </div>
      <div className="flex items-center gap-6 text-lg opacity-60">
        <span>{orgName} / {userEmail.split('@')[0]}</span>
        <button onClick={() => signOut()} className="hover:opacity-100 underline">
          Logout
        </button>
      </div>
    </header>
  )
}
