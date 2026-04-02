import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, ChatSession } from '@/lib/supabase/types'

export async function getOrCreateSession(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<ChatSession> {
  const { data: existing } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('project_id', projectId)
    .single()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('chat_sessions')
    .insert({ project_id: projectId })
    .select()
    .single()

  if (error || !created) {
    throw new Error(`Failed to create chat session: ${error?.message}`)
  }

  return created
}
