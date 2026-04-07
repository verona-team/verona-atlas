'use client'

import { useRouter } from 'next/navigation'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface PanelPageProps {
  projectId: string
  title: string
  children: React.ReactNode
  className?: string
}

export function PanelPage({ projectId, title, children, className }: PanelPageProps) {
  const router = useRouter()

  function handleClose() {
    router.push(`/projects/${projectId}`)
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open) handleClose() }}>
      <SheetContent
        side="right"
        className={cn('sm:max-w-2xl w-full overflow-y-auto', className)}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-4 flex-1">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  )
}
