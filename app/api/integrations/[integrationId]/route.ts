import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'

type RouteContext = { params: Promise<{ integrationId: string }> }

export async function DELETE(
  _request: NextRequest,
  context: RouteContext,
) {
  const { integrationId } = await context.params
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership)
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })

  const { data: integration } = await supabase
    .from('integrations')
    .select('id, project_id, type')
    .eq('id', integrationId)
    .single()

  if (!integration)
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', integration.project_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!project)
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

  const { error } = await supabase
    .from('integrations')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('id', integrationId)

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 })

  if (integration.type === 'github') {
    await clearResearchReportsForProject(supabase, integration.project_id)
  }

  return NextResponse.json({ success: true })
}
