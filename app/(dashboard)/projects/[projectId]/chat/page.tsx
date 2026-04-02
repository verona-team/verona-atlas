import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getOrCreateSession } from '@/lib/chat/session'
import { ChatInterface } from '@/components/chat/chat-interface'
import { ChatNav } from '@/components/chat/chat-nav'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ChatPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
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

  const session = await getOrCreateSession(supabase, projectId)

  const { data: messages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  return (
    <div className="h-[calc(100vh-80px)] max-w-4xl mx-auto flex flex-col">
      <div className="flex items-center justify-between py-4 border-b mb-2">
        <div>
          <h1 className="text-2xl">{project.name}</h1>
          <p className="text-base opacity-40">{project.app_url}</p>
        </div>
        <ChatNav projectId={projectId} />
      </div>
      <div className="flex-1 min-h-0">
        <ChatInterface
          projectId={projectId}
          sessionId={session.id}
          initialMessages={messages ?? []}
          projectName={project.name}
          appUrl={project.app_url}
        />
      </div>
    </div>
  )
}
