import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { chatServerLog } from '@/lib/chat/server-log'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const user = await getServerUser(supabase)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }

    const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10)
    const before = request.nextUrl.searchParams.get('before')

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(limit)

    if (before) {
      query = query.lt('created_at', before)
    }

    const { data: messages, error } = await query

    if (error) {
      chatServerLog('error', 'chat_messages_list_failed', {
        err: error,
        sessionId,
        userId: user.id,
      })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(messages ?? [])
  } catch (err) {
    chatServerLog('error', 'chat_messages_get_unhandled', { err })
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
  }
}
