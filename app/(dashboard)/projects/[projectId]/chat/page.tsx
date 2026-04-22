import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getOrCreateSession } from '@/lib/chat/session'
import { ChatInterface } from '@/components/chat/chat-interface'
import { SettingsQueryOpener } from '@/components/dashboard/settings-query-opener'
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
  if (!gh.ok && settings !== '1') {
    redirect(`/projects/${projectId}/chat?settings=1`)
  }
  const shouldOpenSettings = settings === '1'

  const session = await getOrCreateSession(supabase, projectId)

  const { data: messages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  return (
    <div className="flex h-full flex-col">
      {shouldOpenSettings && <SettingsQueryOpener projectId={projectId} />}
      <ChatInterface
        projectId={projectId}
        sessionId={session.id}
        initialMessages={messages ?? []}
        initialSessionStatus={session.status as 'idle' | 'thinking' | 'error'}
        initialStatusUpdatedAt={session.status_updated_at}
        projectName={project.name}
        appUrl={project.app_url}
      />
    </div>
  )
}
