import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildOAuthURL } from '@/lib/slack'

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const returnTo = request.nextUrl.searchParams.get('return_to')
  const state = returnTo ? `${projectId}::${returnTo}` : projectId

  try {
    const url = buildOAuthURL(state)
    return NextResponse.redirect(url)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to build Slack OAuth URL'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
