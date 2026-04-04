import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'
import { chatServerLog } from '@/lib/chat/server-log'

const FlowActionSchema = z.object({
  messageId: z.string().uuid(),
  flowId: z.string(),
  action: z.enum(['approve', 'reject']),
})

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient()
    const user = await getServerUser(supabase)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch (err) {
      chatServerLog('error', 'chat_flows_patch_invalid_json', { err, userId: user.id })
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = FlowActionSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
    }

    const { messageId, flowId, action } = parsed.data

    const { data: message, error: fetchError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('id', messageId)
      .single()

    if (fetchError || !message) {
      chatServerLog('warn', 'chat_flows_patch_message_not_found', {
        messageId,
        userId: user.id,
        supabaseMessage: fetchError?.message,
      })
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const metadata = (message.metadata ?? {}) as Record<string, Json>
    const proposals = metadata.proposals as { flows?: Array<{ id: string }> } | undefined
    const flowIds =
      proposals?.flows?.map((f) => f.id) ??
      Object.keys((metadata.flow_states ?? {}) as Record<string, string>)

    const previous = (metadata.flow_states ?? {}) as Record<string, string>
    const flowStates: Record<string, string> = {}
    for (const id of flowIds) {
      flowStates[id] = previous[id] ?? 'pending'
    }
    flowStates[flowId] = action === 'approve' ? 'approved' : 'rejected'

    const { error: updateError } = await supabase
      .from('chat_messages')
      .update({
        metadata: { ...metadata, flow_states: flowStates } as unknown as Json,
      })
      .eq('id', messageId)

    if (updateError) {
      chatServerLog('error', 'chat_flows_patch_update_failed', {
        err: updateError,
        messageId,
        flowId,
        userId: user.id,
      })
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ flowId, state: flowStates[flowId] })
  } catch (err) {
    chatServerLog('error', 'chat_flows_patch_unhandled', { err })
    return NextResponse.json({ error: 'Failed to update flow' }, { status: 500 })
  }
}
