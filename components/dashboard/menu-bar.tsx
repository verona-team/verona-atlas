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
    <header className="border-b border-border bg-[#111111]">
      <div className="flex items-center justify-between px-4 h-8">
        <div className="flex items-center gap-4">
          <Link href="/projects" className="font-bold text-sm tracking-widest uppercase text-foreground hover:text-phosphor-bright">
            ◆ Verona
          </Link>
          <span className="text-phosphor-dim text-[11px]">|</span>
          {links.map((link) => {
            const isActive = pathname === link.href || pathname.startsWith(link.href + '/')
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'text-xs uppercase tracking-wider transition-colors',
                  isActive
                    ? 'text-foreground underline underline-offset-4'
                    : 'text-phosphor-dim hover:text-foreground'
                )}
              >
                {link.label}
              </Link>
            )
          })}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-phosphor-dim uppercase tracking-wider">
            {orgName} / {userEmail.split('@')[0]}
          </span>
          <button
            onClick={() => signOut()}
            className="text-[10px] uppercase tracking-wider text-phosphor-dim hover:text-destructive transition-colors"
          >
            [logout]
          </button>
        </div>
      </div>
    </header>
  )
}
