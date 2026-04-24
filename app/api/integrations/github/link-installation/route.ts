import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getServerUser } from '@/lib/supabase/server-user'
import type { Json } from '@/lib/supabase/types'
import {
  listUserInstallations,
  refreshUserToken,
  type GitHubUserToken,
} from '@/lib/github'
import { encrypt, decrypt } from '@/lib/encryption'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'
import { chatServerLog } from '@/lib/chat/server-log'

const Body = z.object({
  project_id: z.string().uuid(),
  installation_id: z.number().int().positive(),
})

/**
 * Link a specific GitHub App installation to a project. Used by the
 * settings UI's installation picker, which handles the case where
 * the OAuth callback found the user with more than one installation
 * and couldn't auto-link.
 *
 * Security: we cross-check the requested installation_id against
 * `GET /user/installations` using the caller's stored OAuth token.
 * That endpoint is scoped to the authenticated GitHub user, so a
 * tampered request that names another customer's installation will
 * simply fail the membership check.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { project_id: projectId, installation_id: installationId } = parsed.data

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

  const service = createServiceRoleClient()
  const { data: identity } = await service
    .from('user_github_identities')
    .select(
      'access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at, github_user_id, github_login',
    )
    .eq('user_id', user.id)
    .maybeSingle()

  if (!identity) {
    return NextResponse.json(
      { error: 'No GitHub identity on file; connect again.' },
      { status: 404 },
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(identity.access_token_encrypted)
  } catch (e) {
    chatServerLog('warn', 'github_link_identity_decrypt_failed', {
      err: e,
      userId: user.id,
    })
    return NextResponse.json(
      { error: 'Stored GitHub identity is unreadable; connect again.' },
      { status: 500 },
    )
  }

  const expiresAt = identity.access_token_expires_at
    ? Date.parse(identity.access_token_expires_at)
    : null
  if (expiresAt !== null && Date.now() >= expiresAt - 60_000) {
    if (!identity.refresh_token_encrypted) {
      return NextResponse.json(
        { error: 'GitHub session expired; connect again.' },
        { status: 401 },
      )
    }
    try {
      const refreshed: GitHubUserToken = await refreshUserToken(
        decrypt(identity.refresh_token_encrypted),
      )
      accessToken = refreshed.accessToken
      await service
        .from('user_github_identities')
        .update({
          access_token_encrypted: encrypt(refreshed.accessToken),
          refresh_token_encrypted: refreshed.refreshToken
            ? encrypt(refreshed.refreshToken)
            : identity.refresh_token_encrypted,
          access_token_expires_at: refreshed.accessTokenExpiresAt,
          refresh_token_expires_at:
            refreshed.refreshTokenExpiresAt ?? identity.refresh_token_expires_at,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)
    } catch (e) {
      chatServerLog('warn', 'github_link_token_refresh_failed', {
        err: e,
        userId: user.id,
      })
      return NextResponse.json(
        { error: 'GitHub session expired; connect again.' },
        { status: 401 },
      )
    }
  }

  let reachable: Set<number>
  try {
    const installations = await listUserInstallations(accessToken)
    reachable = new Set(installations.map((i) => i.id))
  } catch (e) {
    chatServerLog('warn', 'github_link_list_installations_failed', {
      err: e,
      userId: user.id,
    })
    return NextResponse.json(
      { error: 'Failed to verify installation ownership' },
      { status: 500 },
    )
  }

  if (!reachable.has(installationId)) {
    chatServerLog('warn', 'github_link_installation_not_reachable', {
      userId: user.id,
      projectId,
      installationId,
    })
    return NextResponse.json(
      { error: 'You do not have access to that installation' },
      { status: 403 },
    )
  }

  const config: Json = {
    installation_id: installationId,
    setup_action: 'picker_linked',
    repo: null,
    linked_github_user_id: identity.github_user_id,
    linked_github_login: identity.github_login,
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
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await supabase.from('integrations').insert({
      project_id: projectId,
      type: 'github',
      config,
      status: 'active',
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await clearResearchReportsForProject(supabase, projectId)

  chatServerLog('info', 'github_link_installation_picked', {
    userId: user.id,
    projectId,
    installationId,
    githubLogin: identity.github_login,
  })

  return NextResponse.json({ success: true })
}
