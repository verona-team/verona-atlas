import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getOrCreateSession } from '@/lib/chat/session'
import { ChatInterface } from '@/components/chat/chat-interface'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ChatPage({ params }: PageProps) {
  const { projectId } = await params
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
  if (!gh.ok) {
    redirect(`/projects/${projectId}/settings`)
  }

  const session = await getOrCreateSession(supabase, projectId)

  const { data: messages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 w-full max-w-4xl flex-1 mx-auto">
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
    </div>
  )
}
