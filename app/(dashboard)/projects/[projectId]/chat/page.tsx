import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getOrCreateSession } from '@/lib/chat/session'
import { ProjectChatGate } from '@/components/chat/project-chat-gate'
import { SettingsQueryOpener } from '@/components/dashboard/settings-query-opener'
import { SettingsPrefetcher } from '@/components/dashboard/settings-prefetcher'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'

type PageProps = {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ settings?: string }>
}

export default async function ChatPage({ params, searchParams }: PageProps) {
  const { projectId } = await params
  const { settings } = await searchParams
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) notFound()

  const gh = await getGithubIntegrationReady(supabase, projectId)
  const session = await getOrCreateSession(supabase, projectId)

  const { data: messages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  // Seed "test run in flight" for the first paint after a hard refresh.
  // No age filter here — a stuck-worker row older than the
  // `ACTIVE_TEST_RUN_MAX_AGE_MS` safety cap in
  // app/api/chat/session-state/route.ts would only be mis-seeded as
  // "busy" on first paint; the first poll tick (<= 2.5 s later) will
  // authoritatively correct it. Keeping this path purely
  // DB-status-driven avoids reading the wall clock from a React server
  // component, which the purity lint rule forbids.
  const { data: activeRun } = await supabase
    .from('test_runs')
    .select('id')
    .eq('project_id', projectId)
    .eq('trigger', 'chat')
    .in('status', ['pending', 'planning', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const initialHasActiveTestRun = Boolean(activeRun)

  // Settings is a client-side overlay, so we never redirect away from the chat
  // when GitHub isn't ready or when `?settings=1` is present. Instead we just
  // tell the client to open the overlay. This keeps the chat page mounted and
  // avoids a server/client loop where stripping the query param would re-trigger
  // the server guard.
  //
  // Suppress the auto-open while the bootstrap CTA is the landing surface —
  // the CTA already surfaces the GitHub card inline, so stacking the settings
  // overlay on top just double-prompts the user. Manual `?settings=1` still
  // wins (explicit navigation to settings).
  const bootstrapDispatched = Boolean(project.bootstrap_dispatched_at)
  const autoOpenSettings =
    settings === '1' || (bootstrapDispatched && !gh.ok)

  return (
    <div className="flex h-full flex-col">
      {autoOpenSettings && <SettingsQueryOpener projectId={projectId} />}
      <SettingsPrefetcher projectId={projectId} />
      <ProjectChatGate
        bootstrapDispatched={bootstrapDispatched}
        initialMessages={messages ?? []}
        chatProps={{
          projectId,
          sessionId: session.id,
          initialSessionStatus: session.status as 'idle' | 'thinking' | 'error',
          initialStatusUpdatedAt: session.status_updated_at,
          initialHasActiveTestRun,
          projectName: project.name,
          appUrl: project.app_url,
          githubReady: gh.ok,
        }}
      />
    </div>
  )
}
