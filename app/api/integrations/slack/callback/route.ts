import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/encryption'
import { exchangeCodeForToken } from '@/lib/slack'
import type { Json } from '@/lib/supabase/types'

export async function GET(request: NextRequest) {
  const errorParam = request.nextUrl.searchParams.get('error')
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  if (errorParam) {
    const fallback = new URL('/projects', request.nextUrl.origin)
    fallback.searchParams.set('slack_error', errorParam)
    return NextResponse.redirect(fallback)
  }

  if (!code || !state) {
    return NextResponse.json(
      { error: 'Missing code or state' },
      { status: 400 }
    )
  }

  const projectId = state

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.nextUrl.origin))
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  let slack: Awaited<ReturnType<typeof exchangeCodeForToken>>
  try {
    slack = await exchangeCodeForToken(code)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Slack token exchange failed'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const botTokenEncrypted = encrypt(slack.botToken)
  const config: Json = {
    bot_token_encrypted: botTokenEncrypted,
    team_id: slack.teamId || null,
    team_name: slack.teamName || null,
    bot_user_id: slack.botUserId ?? null,
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'slack')
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('integrations')
      .update({ config, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', existing.id)

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await supabase.from('integrations').insert({
      project_id: projectId,
      type: 'slack',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const redirect = new URL(`/projects/${projectId}/settings`, request.nextUrl.origin)
  redirect.searchParams.set('slack', 'connected')
  return NextResponse.redirect(redirect)
}
