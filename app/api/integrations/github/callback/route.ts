import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/types'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.nextUrl.origin))
  }

  const installationId = request.nextUrl.searchParams.get('installation_id')
  const setupAction = request.nextUrl.searchParams.get('setup_action')
  const state = request.nextUrl.searchParams.get('state')

  if (!state) {
    return NextResponse.json({ error: 'Missing state (project id)' }, { status: 400 })
  }

  let projectId = state
  let returnTo: string | null = null
  if (state.includes('::')) {
    const parts = state.split('::')
    projectId = parts[0]
    returnTo = parts.slice(1).join('::')
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

  const installationIdNum = installationId ? Number(installationId) : null

  const config: Json = {
    installation_id: installationIdNum ?? installationId,
    setup_action: setupAction,
    // User must pick exactly one repo via the UI; do not pre-fill all installation repos.
    repos: [],
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'github')
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
      type: 'github',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const redirectPath = returnTo || `/projects/${projectId}/settings`
  const redirect = new URL(redirectPath, request.nextUrl.origin)
  redirect.searchParams.set('github', 'connected')
  return NextResponse.redirect(redirect)
}
