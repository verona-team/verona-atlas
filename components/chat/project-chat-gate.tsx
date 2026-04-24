'use client'

import { useCallback, useState } from 'react'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ProjectSetupCTA } from '@/components/chat/project-setup-cta'
import type { ChatMessage } from '@/lib/supabase/types'

/**
 * Switches between the pre-bootstrap setup CTA and the live chat experience
 * for a single project, based on `projects.bootstrap_dispatched_at`.
 *
 * The gate exists so `ChatInterface` — whose empty-thread `useEffect`
 * auto-sends the bootstrap user turn to `/api/chat` — is literally not
 * mounted until the user has explicitly armed things. That preserves the
 * existing bootstrap logic (no new props, no new gating branches inside the
 * chat component) while letting us defer agent work to an explicit user
 * action.
 *
 * The flow:
 *  1. SSR reads `project.bootstrap_dispatched_at` and passes `bootstrapDispatched`.
 *  2. If unset, `<ProjectSetupCTA />` is rendered instead of the chat.
 *  3. The CTA flips the DB flag via POST /api/projects/:id/dispatch-bootstrap
 *     and then calls `onDispatched()`, which updates local `dispatched`
 *     state — no `router.refresh()` required, no SSR re-run, no flicker.
 *  4. `<ChatInterface />` mounts; its existing bootstrap `useEffect` fires
 *     once the thread is empty and GitHub is ready.
 */
type ChatInterfaceProps = React.ComponentProps<typeof ChatInterface>

type ProjectChatGateProps = {
  bootstrapDispatched: boolean
  initialMessages: ChatMessage[]
  chatProps: Omit<ChatInterfaceProps, 'initialMessages'>
}

export function ProjectChatGate({
  bootstrapDispatched,
  initialMessages,
  chatProps,
}: ProjectChatGateProps) {
  const [dispatched, setDispatched] = useState(bootstrapDispatched)
  /**
   * The CTA can finish connecting GitHub inline (no SSR re-run), so by the
   * time we swap to `<ChatInterface>` the live GitHub-ready value is often
   * ahead of `chatProps.githubReady` (which was baked into SSR). When the
   * CTA calls `onDispatched(liveGithubReady)` we capture it here and use
   * it as the override when mounting the chat. `null` means "no override"
   * — the SSR-authoritative path (hard refresh, project already armed,
   * etc.) stays on the server-provided value.
   */
  const [githubReadyOverride, setGithubReadyOverride] = useState<boolean | null>(
    null,
  )

  const handleDispatched = useCallback((liveGithubReady: boolean) => {
    setGithubReadyOverride(liveGithubReady)
    setDispatched(true)
  }, [])

  if (!dispatched) {
    return (
      <ProjectSetupCTA
        projectId={chatProps.projectId}
        projectName={chatProps.projectName}
        appUrl={chatProps.appUrl}
        initialGithubReady={chatProps.githubReady}
        onDispatched={handleDispatched}
      />
    )
  }

  const effectiveChatProps =
    githubReadyOverride === null
      ? chatProps
      : { ...chatProps, githubReady: githubReadyOverride }

  return (
    <ChatInterface {...effectiveChatProps} initialMessages={initialMessages} />
  )
}
