import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { listInstallationRepos } from '@/lib/github'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'
import {
  githubRepoFullName,
  githubRepoToJson,
} from '@/lib/github-integration-config'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
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
    .eq('type', 'github')
    .eq('status', 'active')
    .maybeSingle()

  if (!integration) {
    return NextResponse.json({ error: 'GitHub not connected' }, { status: 404 })
  }

  const config = integration.config as Record<string, Json>
  const installationId = config.installation_id as number
  if (!installationId) {
    return NextResponse.json({ error: 'Missing installation_id' }, { status: 400 })
  }

  try {
    const installationRepos = await listInstallationRepos(installationId)
    const linkedFullName = githubRepoFullName(config)

    return NextResponse.json({
      repos: installationRepos.map((r) => ({
        full_name: r.fullName,
        private: r.private,
        default_branch: r.defaultBranch,
        selected: linkedFullName === r.fullName,
      })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to list repos'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

const UpdateRepoSchema = z.object({
  project_id: z.string().uuid(),
  repo_full_name: z.string().min(1),
})

export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = UpdateRepoSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { project_id: projectId, repo_full_name: repoFullName } = parsed.data

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
    .eq('type', 'github')
    .eq('status', 'active')
    .maybeSingle()

  if (!integration) {
    return NextResponse.json({ error: 'GitHub not connected' }, { status: 404 })
  }

  const config = integration.config as Record<string, Json>
  const installationId = config.installation_id as number
  if (!installationId) {
    return NextResponse.json({ error: 'Missing installation_id' }, { status: 400 })
  }

  const allRepos = await listInstallationRepos(installationId)
  const match = allRepos.find((r) => r.fullName === repoFullName)
  if (!match) {
    return NextResponse.json(
      { error: `Repository not accessible to this installation: ${repoFullName}` },
      { status: 400 },
    )
  }

  const repoJson = githubRepoToJson({
    full_name: match.fullName,
    private: match.private,
    default_branch: match.defaultBranch,
  })

  const updatedConfig: Json = {
    ...config,
    repo: repoJson,
  }

  const { error } = await supabase
    .from('integrations')
    .update({ config: updatedConfig, updated_at: new Date().toISOString() })
    .eq('id', integration.id)

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 })

  await clearResearchReportsForProject(supabase, projectId)

  return NextResponse.json({ success: true, repo: repoJson })
}
