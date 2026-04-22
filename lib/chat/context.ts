import { generateText } from '@/lib/langsmith-ai'
import { model } from '@/lib/ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, ChatMessage } from '@/lib/supabase/types'
import { chatServerLog } from '@/lib/chat/server-log'

const RECENT_MESSAGE_LIMIT = 30
const SUMMARIZE_THRESHOLD = 50

export async function buildChatContext(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<{ contextSummary: string | null; recentMessages: ChatMessage[] }> {
  const { data: session } = await supabase
    .from('chat_sessions')
    .select('context_summary')
    .eq('id', sessionId)
    .single()

  const { data: recentMessages } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(RECENT_MESSAGE_LIMIT)

  const messages = (recentMessages ?? []).reverse()

  return {
    contextSummary: session?.context_summary ?? null,
    recentMessages: messages,
  }
}

export async function maybeSummarizeOlderMessages(
  supabase: SupabaseClient<Database>,
  sessionId: string,
): Promise<void> {
  try {
    const { count } = await supabase
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)

    if (!count || count < SUMMARIZE_THRESHOLD) return

    const { data: allMessages } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })

    if (!allMessages || allMessages.length < SUMMARIZE_THRESHOLD) return

    const messagesToSummarize = allMessages.slice(0, -RECENT_MESSAGE_LIMIT)
    if (messagesToSummarize.length === 0) return

    const { data: session } = await supabase
      .from('chat_sessions')
      .select('context_summary')
      .eq('id', sessionId)
      .single()

    const existingSummary = session?.context_summary ?? ''

    const conversationText = messagesToSummarize
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n')

    const { text: newSummary } = await generateText({
      model,
      prompt: `You are compressing an older portion of a QA testing chat into a durable context summary. A future session will read only this summary (not the raw messages) to stay consistent with prior decisions.

# Must preserve

- Test flows proposed, and for each: whether it was approved, rejected, edited, or superseded — plus the reason if given.
- User preferences (e.g. "always include auth smoke test", "skip enterprise flows", "test production only").
- Explicit testing-strategy instructions from the user.
- Outcomes of past test runs discussed (pass/fail, notable failures, follow-ups).
- Open questions or TODOs the user asked to come back to.

# Drop

- Pleasantries, acknowledgements, filler.
- Research-report recitations — those are re-injected separately each turn.
- Step-by-step details of flows; reference by name and priority only.

# Output rules

- Plain prose with short labeled sections ("Flows:", "Preferences:", "Open items:"). No markdown headings beyond that.
- Keep under 1000 words. Be concrete — names, IDs, numbers — not narrative.
- If a previous summary exists, MERGE with it: update superseded facts, keep still-valid facts, drop anything the new messages resolved.

${existingSummary ? `# Previous summary\n${existingSummary}\n\n` : ''}# New messages to incorporate
${conversationText}`,
    })

    const { error: updateErr } = await supabase
      .from('chat_sessions')
      .update({
        context_summary: newSummary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId)

    if (updateErr) {
      chatServerLog('error', 'chat_context_summary_update_failed', {
        err: updateErr,
        sessionId,
      })
      return
    }

    const idsToDelete = messagesToSummarize.map((m) => m.id)
    const { error: deleteErr } = await supabase.from('chat_messages').delete().in('id', idsToDelete)
    if (deleteErr) {
      chatServerLog('error', 'chat_context_summary_delete_old_messages_failed', {
        err: deleteErr,
        sessionId,
        deletedCount: idsToDelete.length,
      })
    }
  } catch (err) {
    chatServerLog('error', 'chat_maybe_summarize_failed', { err, sessionId })
  }
}
