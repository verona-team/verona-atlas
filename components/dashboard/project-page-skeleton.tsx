'use client'

import { useContext } from 'react'
import { useParams } from 'next/navigation'
import { WorkspaceContext } from '@/lib/workspace-context'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Loading fallback for `/projects/[projectId]/*` segments.
 *
 * The project page surfaces two very different layouts depending on
 * `projects.bootstrap_dispatched_at`:
 *   - CTA state (NULL): a centered "Finish setting up X" panel with a
 *     stack of integration cards and a Continue button.
 *   - Chat state (set):  a scrolling messages column with a chat input
 *     pinned to the bottom.
 *
 * We render a different skeleton for each so the placeholder closely
 * matches the real content the user is about to see, instead of a
 * generic spinner. The dashboard layout's `WorkspaceProvider` seeds the
 * full `projects` list at SSR time, so on a client navigation we can
 * read the bootstrap flag synchronously from context — no extra fetch
 * required.
 *
 * On a hard refresh the loading.tsx fallback runs while the dashboard
 * layout itself is still resolving on the server, so `useWorkspace()`
 * isn't reachable and `WorkspaceProvider` hasn't mounted yet. In that
 * case Next.js doesn't actually render this fallback (the layout chunk
 * is part of the same server render), so the missing-context branch
 * here is effectively only the "project not found in cache" edge case
 * for newly-created projects mid-session. We fall back to the chat
 * skeleton (the steady-state experience) for that path.
 */
export function ProjectPageSkeleton() {
  const params = useParams<{ projectId: string }>()
  const projectId = params?.projectId

  // Read context directly so we can degrade gracefully when no
  // WorkspaceProvider is in scope (e.g. on a hard refresh, when the
  // dashboard layout is still resolving). The throwing helper
  // `useWorkspace()` would crash this fallback.
  const workspace = useContext(WorkspaceContext)
  let bootstrapDispatched: boolean | null = null
  if (workspace) {
    const project = workspace.projects.find((p) => p.id === projectId)
    if (project) {
      bootstrapDispatched = Boolean(project.bootstrap_dispatched_at)
    }
  }

  if (bootstrapDispatched === false) {
    return <ProjectSetupCTASkeleton />
  }
  return <ProjectChatSkeleton />
}

/**
 * Skeleton mirroring `<ProjectSetupCTA />`: header block, integration
 * card stack, and a wide Continue button. The dimensions are kept in
 * sync with the real component's spacing (max-w-2xl, py-10/14, space-y-3
 * cards) so the swap-in is visually quiet.
 */
function ProjectSetupCTASkeleton() {
  return (
    <div className="flex h-full flex-col overflow-y-auto" aria-busy="true">
      <div className="mx-auto w-full max-w-2xl px-6 py-10 sm:py-14">
        <header className="mb-6 space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-full max-w-md" />
        </header>

        <div className="space-y-3">
          <IntegrationCardSkeleton />
          <IntegrationCardSkeleton />
          <AdvancedSectionSkeleton />
        </div>

        <div className="mt-6">
          <Skeleton className="h-11 w-full rounded-md" />
        </div>
      </div>
    </div>
  )
}

function IntegrationCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
    </div>
  )
}

function AdvancedSectionSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-4 rounded" />
      </div>
    </div>
  )
}

/**
 * Skeleton mirroring `<ChatInterface />` after a turn already exists:
 * one user bubble + one assistant response in the scroll column, plus
 * a chat input pinned to the bottom. Two bubbles is enough to anchor
 * the "this is a chat" expectation without making the placeholder
 * busier than the real content that's about to swap in. We deliberately
 * don't render a "V" hero state here because that's only shown when
 * the thread is empty *and* not processing — most navigations land on
 * a thread with at least the bootstrap turn already persisted.
 */
function ProjectChatSkeleton() {
  return (
    <div className="relative flex h-full flex-col" aria-busy="true">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] space-y-8 px-6 py-8">
          <UserBubbleSkeleton />
          <AssistantBubbleSkeleton />
        </div>
      </div>

      <div className="relative shrink-0">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
        />
        <div className="mx-auto w-full max-w-[760px] px-6 pb-4 pt-2">
          <div className="rounded-2xl border border-border bg-card px-4 py-4 shadow-sm">
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Mirrors the real user bubble in `MessageBubble`: a short rounded-2xl
 * pill, right-aligned, single line of text height. The real component
 * uses `rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed`,
 * which renders a ~40px-tall capsule for one line of content. We render
 * the entire bubble as one Skeleton element with a fixed width so it
 * actually looks like a user message instead of a tall thin column.
 */
function UserBubbleSkeleton() {
  return (
    <div className="flex justify-end">
      <Skeleton className="h-10 w-80 max-w-[80%] rounded-2xl" />
    </div>
  )
}

/**
 * Mirrors an assistant text bubble: full-width markdown column with a
 * few lines of body text. No bubble background — the real assistant
 * bubble is plain text on the page background, not a chip.
 */
function AssistantBubbleSkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-[92%]" />
      <Skeleton className="h-4 w-[88%]" />
      <Skeleton className="h-4 w-[40%]" />
    </div>
  )
}
