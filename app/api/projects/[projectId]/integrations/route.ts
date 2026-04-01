import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/types'

type RouteContext = { params: Promise<{ projectId: string }> }

export async function GET(
  _request: NextRequest,
  context: RouteContext,
) {
  const { projectId } = await context.params
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

  if (!project)
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, type, status, config, created_at, updated_at')
    .eq('project_id', projectId)

  const sanitized = (integrations || []).map((i) => {
    const config = i.config as Record<string, Json>
    return {
      id: i.id,
      type: i.type,
      status: i.status,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      meta: sanitizeConfig(i.type, config),
    }
  })

  return NextResponse.json({ integrations: sanitized })
}

function sanitizeConfig(
  type: string,
  config: Record<string, Json>,
): Record<string, Json> {
  switch (type) {
    case 'github': {
      const repos = (config.repos as Array<Record<string, Json>>) || []
      return {
        installation_id: config.installation_id ?? null,
        repos: repos.map((r) => ({
          full_name: r.full_name,
          private: r.private,
        })),
      }
    }
    case 'posthog':
      return {
        posthog_project_id: config.posthog_project_id ?? null,
        api_host: config.api_host ?? null,
      }
    case 'sentry':
      return {
        organization_slug: config.organization_slug ?? null,
        project_slug: config.project_slug ?? null,
      }
    case 'langsmith':
      return {
        project_name: config.project_name ?? null,
        api_url: config.api_url ?? null,
      }
    case 'braintrust':
      return {
        project_name: config.project_name ?? null,
        api_url: config.api_url ?? null,
      }
    case 'slack':
      return {
        team_name: config.team_name ?? null,
        channel_id: config.channel_id ?? null,
        channel_name: config.channel_name ?? null,
      }
    default:
      return {}
  }
}
