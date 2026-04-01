'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from '@/app/actions/auth'
import { cn } from '@/lib/utils'

interface MenuBarProps {
  userEmail: string
  orgName: string
}

export function MenuBar({ userEmail, orgName }: MenuBarProps) {
  const pathname = usePathname()

  const links = [
    { label: 'Projects', href: '/projects' },
  ]

  return (
    <header className="border-b-2 border-[#1a1a1a] bg-[#fffef9]">
      <div className="flex items-center justify-between px-4 h-8">
        <div className="flex items-center gap-4">
          <Link href="/projects" className="font-bold text-sm tracking-widest uppercase text-[#1a1a1a] hover:underline">
            ◆ Verona
          </Link>
          <span className="text-[#b8b3a4] text-[11px]">|</span>
          {links.map((link) => {
            const isActive = pathname === link.href || pathname.startsWith(link.href + '/')
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'text-xs uppercase tracking-wider transition-colors',
                  isActive
                    ? 'text-[#1a1a1a] underline underline-offset-4'
                    : 'text-[#6b6555] hover:text-[#1a1a1a]'
                )}
              >
                {link.label}
              </Link>
            )
          })}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-[#6b6555] uppercase tracking-wider">
            {orgName} / {userEmail.split('@')[0]}
          </span>
          <button
            onClick={() => signOut()}
            className="text-[10px] uppercase tracking-wider text-[#6b6555] hover:text-[#c43333] transition-colors"
          >
            [logout]
          </button>
        </div>
      </div>
    </header>
  )
}
