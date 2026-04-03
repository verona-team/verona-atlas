import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getOrCreateSession } from '@/lib/chat/session'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ChatNav } from '@/components/chat/chat-nav'
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
    redirect(`/projects/${projectId}/setup`)
  }

  const session = await getOrCreateSession(supabase, projectId)

  const { data: messages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  return (
    <div className="fixed inset-0 top-12 flex flex-col">
      <div className="shrink-0 px-6 pb-3 pt-3 md:px-12 lg:px-16">
        <div className="flex flex-col gap-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">{project.name}</h1>
            <a
              href={project.app_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block truncate text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              {project.app_url}
            </a>
          </div>
          <div className="shrink-0 sm:pl-2">
            <ChatNav projectId={projectId} />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 w-full max-w-4xl flex-1 mx-auto">
        <ChatInterface
          projectId={projectId}
          sessionId={session.id}
          initialMessages={messages ?? []}
          initialSessionStatus={session.status}
          initialStatusUpdatedAt={session.status_updated_at}
          projectName={project.name}
          appUrl={project.app_url}
        />
      </div>
    </div>
  )
}
