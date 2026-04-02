'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MessageSquare, LayoutList, History, Settings, BarChart3 } from 'lucide-react'

interface ChatNavProps {
  projectId: string
}

const navItems = [
  { label: 'Chat', href: 'chat', icon: MessageSquare },
  { label: 'Overview', href: 'overview', icon: BarChart3 },
  { label: 'Templates', href: 'templates', icon: LayoutList },
  { label: 'Runs', href: 'runs', icon: History },
  { label: 'Settings', href: 'settings', icon: Settings },
]

export function ChatNav({ projectId }: ChatNavProps) {
  const pathname = usePathname()

  return (
    <nav className="flex items-center gap-1 text-sm">
      {navItems.map((item) => {
        const href = `/projects/${projectId}/${item.href}`
        const isActive = pathname === href || pathname.startsWith(href + '/')
        return (
          <Link
            key={item.href}
            href={href}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
              isActive
                ? 'bg-foreground/10'
                : 'opacity-40 hover:opacity-70'
            }`}
          >
            <item.icon className="w-3.5 h-3.5" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
