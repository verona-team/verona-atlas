import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getPostHogClient } from '@/lib/posthog-server'

type RouteContext = { params: Promise<{ projectId: string }> }

async function getProjectForUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  projectId: string
) {
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .limit(1)
    .single()

  if (!membership) return { membership: null, project: null as null }

  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (error || !project) return { membership, project: null as null }
  return { membership, project }
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { projectId } = await context.params
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { project } = await getProjectForUser(supabase, user.id, projectId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(project)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { projectId } = await context.params
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { membership, project } = await getProjectForUser(supabase, user.id, projectId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (membership?.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await supabase.from('projects').delete().eq('id', projectId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  getPostHogClient().capture({
    distinctId: user.id,
    event: 'project_deleted',
    properties: {
      project_id: projectId,
      project_name: project.name,
      app_url: project.app_url,
    },
  })

  return new NextResponse(null, { status: 204 })
}
