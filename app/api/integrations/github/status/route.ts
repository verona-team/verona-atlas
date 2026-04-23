import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import type { Json } from '@/lib/supabase/types'

/**
 * Polls for a GitHub App installation that can be linked to this project.
 *
 * Two resolution paths exist:
 *
 * 1. First-time install. The user has never installed the Verona GitHub App
 *    on this account before. The install popup walks them through creating
 *    a brand-new installation and GitHub fires the post-install setup
 *    callback at `/api/integrations/github/callback`, which writes the
 *    integration row authoritatively. This endpoint plays no role in that
 *    path — we simply observe the row once it exists and return
 *    `connected: true` on the next poll tick.
 *
 * 2. Repeat install. The user already installed the app on the same GitHub
 *    account for a previous project. GitHub will not fire the callback for
 *    a re-use — it just shows the "Configure" screen. This endpoint
 *    bridges that gap by reusing the existing installation the user's own
 *    orgs have already linked.
 *
 * The endpoint deliberately does NOT claim a GitHub installation that the
 * user's orgs have not previously linked. Doing so would be a cross-tenant
 * leak in a multi-customer deployment, because `GET /app/installations` is
 * authenticated as the GitHub App itself and returns every customer's
 * installation. The only safe signal that an installation belongs to the
 * current caller is "it already appears in an integrations row inside one
 * of their own orgs" — which is enforced by RLS on the integrations table.
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
    .select('id, org_id')
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

  // RLS-scoped: only installations already linked to integrations inside the
  // caller's own orgs. This is the only pool we'll ever claim from — see
  // the docstring for why.
  const { data: userOrgIntegrations } = await supabase
    .from('integrations')
    .select('config, updated_at')
    .eq('type', 'github')
    .eq('status', 'active')

  const userOrgInstallations = new Map<number, number>()
  for (const row of userOrgIntegrations ?? []) {
    const config = row.config as Record<string, Json> | null
    const rawId = config?.installation_id
    const installationId =
      typeof rawId === 'number'
        ? rawId
        : typeof rawId === 'string' && rawId.length > 0
          ? Number(rawId)
          : NaN
    if (!Number.isFinite(installationId)) continue
    const ts = row.updated_at ? Date.parse(row.updated_at) : 0
    const prev = userOrgInstallations.get(installationId) ?? -1
    if (ts > prev) userOrgInstallations.set(installationId, ts)
  }

  if (userOrgInstallations.size === 0) {
    // The caller has no reusable installation on file. First-time connect
    // must be resolved by the OAuth setup callback — not us.
    return NextResponse.json({ connected: false })
  }

  // Intersect with GitHub's authoritative list so we never return an
  // installation that GitHub no longer knows about (e.g. user uninstalled
  // the app on GitHub's side but we still have a stale row).
  let liveInstallationIds: Set<number>
  try {
    const app = new App({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64').toString('utf8'),
      Octokit,
    })
    const { data } = await app.octokit.request('GET /app/installations', {
      per_page: 100,
    })
    liveInstallationIds = new Set(data.map((i) => i.id))
  } catch (e) {
    console.error('Failed to list GitHub App installations:', e)
    return NextResponse.json({ connected: false })
  }

  let chosenInstallationId: number | null = null
  let bestTs = -1
  for (const [installationId, ts] of userOrgInstallations) {
    if (!liveInstallationIds.has(installationId)) continue
    if (ts > bestTs) {
      bestTs = ts
      chosenInstallationId = installationId
    }
  }

  if (chosenInstallationId === null) {
    return NextResponse.json({ connected: false })
  }

  const config: Json = {
    installation_id: chosenInstallationId,
    setup_action: 'install',
    repo: null,
  }

  const { error } = await supabase.from('integrations').insert({
    project_id: projectId,
    type: 'github',
    config,
    status: 'active',
  })

  if (error) {
    // A concurrent callback/status race may have inserted the row first.
    // If the row now exists, treat this as success.
    const { data: raceRow } = await supabase
      .from('integrations')
      .select('id')
      .eq('project_id', projectId)
      .eq('type', 'github')
      .eq('status', 'active')
      .maybeSingle()
    if (raceRow) {
      return NextResponse.json({ connected: true, justLinked: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ connected: true, justLinked: true })
}
