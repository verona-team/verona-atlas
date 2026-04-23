import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import type { Json } from '@/lib/supabase/types'

type InstallationSummary = {
  id: number
  updatedAtMs: number
}

/**
 * Polls for a GitHub App installation that can be linked to this project.
 *
 * Background: our GitHub App's install flow redirects back to
 * `/api/integrations/github/callback` only when GitHub actually fires the
 * post-install setup callback. That callback never fires when the user
 * reuses an existing installation (e.g. they already installed the app on
 * the same account for a previous project, and GitHub drops them on the
 * "Configure" screen instead of the install screen). This endpoint bridges
 * that gap.
 *
 * Resolution order when the current project has no GitHub integration yet:
 *   1. If there is an App installation that is NOT linked to any project,
 *      adopt it for the current project (first-time install path).
 *   2. Otherwise, if any of the user's own orgs already has an integration
 *      pointing at one of the App's installations, reuse the most recently
 *      updated such installation for the current project (repeat-install
 *      path — the previous bug).
 *   3. Otherwise, the user genuinely hasn't authorized an installation yet;
 *      return `connected: false` and let the UI keep waiting.
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

  let installations: InstallationSummary[]
  try {
    const app = new App({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64').toString('utf8'),
      Octokit,
    })
    const { data } = await app.octokit.request('GET /app/installations', {
      per_page: 100,
    })
    installations = data.map((i) => ({
      id: i.id,
      updatedAtMs: i.updated_at ? Date.parse(i.updated_at) : 0,
    }))
  } catch (e) {
    console.error('Failed to list GitHub App installations:', e)
    return NextResponse.json({ connected: false })
  }

  if (installations.length === 0) {
    return NextResponse.json({ connected: false })
  }

  // All active GitHub integrations we can see. RLS limits this to rows that
  // live under orgs the user is a member of — exactly what we want for the
  // "reuse an installation I've already set up" fallback. We do NOT want to
  // include integrations from other orgs here (even though the install may
  // technically belong to the same GitHub account) because claiming an
  // installation owned by a different customer would be a cross-tenant leak.
  const { data: userOrgIntegrations } = await supabase
    .from('integrations')
    .select('config, updated_at')
    .eq('type', 'github')
    .eq('status', 'active')

  const userOrgInstallationHits = new Map<number, number>()
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
    const prev = userOrgInstallationHits.get(installationId) ?? -1
    if (ts > prev) userOrgInstallationHits.set(installationId, ts)
  }

  // Step 1: is there any installation that isn't linked to ANY project visible
  // to this user? That's the classic "user just installed it for this project"
  // signal.
  const unlinked = installations.filter(
    (inst) => !userOrgInstallationHits.has(inst.id),
  )

  let chosenInstallationId: number | null = null

  if (unlinked.length > 0) {
    // Most recently touched install is the one the user just interacted with.
    chosenInstallationId = unlinked.reduce((best, inst) =>
      inst.updatedAtMs > best.updatedAtMs ? inst : best,
    ).id
  } else {
    // Step 2: reuse an installation the user has already linked to one of
    // their own projects. This is the missing branch that caused the
    // repeat-connect infinite-loop bug.
    let bestId: number | null = null
    let bestTs = -1
    for (const inst of installations) {
      const ts = userOrgInstallationHits.get(inst.id)
      if (ts === undefined) continue
      if (ts > bestTs) {
        bestTs = ts
        bestId = inst.id
      }
    }
    chosenInstallationId = bestId
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
