import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/encryption'
import { listChannels } from '@/lib/slack'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership)
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project)
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: integration } = await supabase
    .from('integrations')
    .select('config')
    .eq('project_id', projectId)
    .eq('type', 'slack')
    .eq('status', 'active')
    .maybeSingle()

  if (!integration) {
    return NextResponse.json({ error: 'Slack not connected' }, { status: 404 })
  }

  const config = integration.config as Record<string, Json>
  const botTokenEncrypted = config.bot_token_encrypted as string
  if (!botTokenEncrypted) {
    return NextResponse.json({ error: 'Missing bot token' }, { status: 400 })
  }

  try {
    const botToken = decrypt(botTokenEncrypted)
    const channels = await listChannels(botToken)
    const currentChannelId = config.channel_id as string | undefined

    return NextResponse.json({
      channels,
      currentChannelId: currentChannelId || null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to list channels'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

const SetChannelSchema = z.object({
  project_id: z.string().uuid(),
  channel_id: z.string().min(1),
  channel_name: z.string().optional(),
})

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = SetChannelSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { project_id: projectId, channel_id: channelId, channel_name: channelName } = parsed.data

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership)
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project)
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: integration } = await supabase
    .from('integrations')
    .select('id, config')
    .eq('project_id', projectId)
    .eq('type', 'slack')
    .eq('status', 'active')
    .maybeSingle()

  if (!integration) {
    return NextResponse.json({ error: 'Slack not connected' }, { status: 404 })
  }

  const config = integration.config as Record<string, Json>
  const updatedConfig: Json = {
    ...config,
    channel_id: channelId,
    channel_name: channelName || null,
  }

  const { error } = await supabase
    .from('integrations')
    .update({ config: updatedConfig, updated_at: new Date().toISOString() })
    .eq('id', integration.id)

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
