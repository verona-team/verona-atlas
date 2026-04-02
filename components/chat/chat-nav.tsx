'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MessageSquare, History, Settings } from 'lucide-react'

interface ChatNavProps {
  projectId: string
}

const navItems = [
  { label: 'Chat', href: 'chat', icon: MessageSquare },
  { label: 'Runs', href: 'runs', icon: History },
  { label: 'Settings', href: 'settings', icon: Settings },
]

export function ChatNav({ projectId }: ChatNavProps) {
  const pathname = usePathname()

  return (
    <nav
      className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-background/80 p-0.5 text-sm shadow-sm"
      aria-label="Project"
    >
      {navItems.map((item) => {
        const href = `/projects/${projectId}/${item.href}`
        const isActive = pathname === href || pathname.startsWith(href + '/')
        return (
          <Link
            key={item.href}
            href={href}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors ${
              isActive
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80'
            }`}
          >
            <item.icon className="h-3.5 w-3.5 opacity-80" aria-hidden />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
