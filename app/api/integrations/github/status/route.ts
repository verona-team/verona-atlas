import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import type { Json } from '@/lib/supabase/types'

/**
 * Polls for a GitHub App installation that hasn't been linked to this project yet.
 * When the setup_url is not configured on the GitHub App, the callback never fires
 * after installation. This endpoint bridges the gap by:
 * 1. Listing all installations of our GitHub App
 * 2. Checking if any installation is NOT yet linked to any project
 * 3. If found, creating the integration row for this project
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 })
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

  const { data: existingIntegration } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'github')
    .eq('status', 'active')
    .maybeSingle()

  if (existingIntegration) {
    return NextResponse.json({ connected: true })
  }

  try {
    const app = new App({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64').toString('utf8'),
      Octokit,
    })

    const { data: installations } = await app.octokit.request('GET /app/installations', {
      per_page: 100,
    })

    const { data: allGithubIntegrations } = await supabase
      .from('integrations')
      .select('config')
      .eq('type', 'github')
      .eq('status', 'active')

    const linkedInstallationIds = new Set(
      (allGithubIntegrations || []).map((i) => {
        const config = i.config as Record<string, Json>
        return Number(config.installation_id)
      }).filter(Boolean),
    )

    const unlinked = installations.filter(
      (inst) => !linkedInstallationIds.has(inst.id),
    )

    if (unlinked.length === 0) {
      return NextResponse.json({ connected: false })
    }

    const installation = unlinked[unlinked.length - 1]

    const config: Json = {
      installation_id: installation.id,
      setup_action: 'install',
      repos: [],
    }

    const { error } = await supabase.from('integrations').insert({
      project_id: projectId,
      type: 'github',
      config,
      status: 'active',
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ connected: true, justLinked: true })
  } catch (e) {
    console.error('Failed to check GitHub installations:', e)
    return NextResponse.json({ connected: false })
  }
}
