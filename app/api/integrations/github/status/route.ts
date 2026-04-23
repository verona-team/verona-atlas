import { NextRequest, NextResponse } from 'next/server'
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
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * Poll target for the GitHub connect flow. Two resolution layers:
 *
 *   1. Integration row already exists for the project → connected.
 *
 *   2. User-identity layer. Look up the caller's stored GitHub OAuth
 *      token in `user_github_identities`, list their installations via
 *      `GET /user/installations` (user-scoped — the authenticated human
 *      themselves vouches for ownership), and auto-link if there's
 *      exactly one installation they can access. Multiple projects in
 *      the same Verona org intentionally CAN share one installation_id
 *      (one GitHub installation covers an entire account and serves
 *      repo access per-installation, not per-project), so we don't
 *      filter on "already used by another project." If the user has
 *      more than one GitHub installation, we return
 *      `AMBIGUOUS_MULTIPLE_INSTALLATIONS` so the UI can prompt a pick
 *      rather than silently guessing.
 *
 * Both the callback handler (authoritative write) and this endpoint can
 * create integration rows. Whichever fires first wins; the other
 * observes the row and short-circuits at layer 1.
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

  // Layer 1: existing integration row short-circuit.
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

  // Layer 2: user-identity-scoped auto-link.
  const result = await tryLinkViaUserIdentity({
    userId: user.id,
    projectId,
  })
  if (result.resolved) {
    return NextResponse.json({
      connected: true,
      justLinked: true,
      via: 'user_identity',
    })
  }
  if (result.reason) {
    return NextResponse.json({
      connected: false,
      reason: result.reason,
    })
  }
  return NextResponse.json({ connected: false })
}

type LinkResult =
  | { resolved: true }
  | {
      resolved: false
      reason?: 'AMBIGUOUS_MULTIPLE_INSTALLATIONS'
    }

async function tryLinkViaUserIdentity(opts: {
  userId: string
  projectId: string
}): Promise<LinkResult> {
  const { userId, projectId } = opts
  const service = createServiceRoleClient()

  const { data: identity } = await service
    .from('user_github_identities')
    .select(
      'access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at, github_login',
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (!identity) return { resolved: false }

  let accessToken: string
  try {
    accessToken = decrypt(identity.access_token_encrypted)
  } catch (e) {
    chatServerLog('warn', 'github_status_identity_decrypt_failed', { err: e, userId })
    return { resolved: false }
  }

  // Refresh if we know it's expired. If there's no refresh token,
  // `/user/installations` will 401 and we'll return { resolved: false };
  // the user needs to re-connect via the UI.
  const expiresAt = identity.access_token_expires_at
    ? Date.parse(identity.access_token_expires_at)
    : null
  if (expiresAt !== null && Date.now() >= expiresAt - 60_000) {
    if (identity.refresh_token_encrypted) {
      try {
        const refreshed: GitHubUserToken = await refreshUserToken(
          decrypt(identity.refresh_token_encrypted),
        )
        accessToken = refreshed.accessToken
        // Persist the new tokens so future polls don't refresh again.
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
          .eq('user_id', userId)
      } catch (e) {
        chatServerLog('warn', 'github_status_token_refresh_failed', {
          err: e,
          userId,
        })
        return { resolved: false }
      }
    }
  }

  let userInstallations: Awaited<ReturnType<typeof listUserInstallations>>
  try {
    userInstallations = await listUserInstallations(accessToken)
  } catch (e) {
    chatServerLog('warn', 'github_status_list_user_installations_failed', {
      err: e,
      userId,
    })
    return { resolved: false }
  }

  if (userInstallations.length === 0) {
    return { resolved: false }
  }

  // Multiple GitHub installations (e.g. user has Verona installed on both
  // their personal account and a work org) — we don't know which one they
  // want for this project. Surface the ambiguity so the UI can prompt
  // rather than silently guessing. In the common case the callback path
  // resolves this already via the `installation_id` query param; this
  // branch only matters when the callback didn't fire (reconfigure with
  // no changes).
  if (userInstallations.length > 1) {
    return { resolved: false, reason: 'AMBIGUOUS_MULTIPLE_INSTALLATIONS' }
  }

  const chosenInstallationId = userInstallations[0].id
  const config: Json = {
    installation_id: chosenInstallationId,
    setup_action: 'status_linked',
    repo: null,
    linked_github_login: identity.github_login,
  }

  const { error } = await service.from('integrations').insert({
    project_id: projectId,
    type: 'github',
    config,
    status: 'active',
  })

  if (error) {
    // Racing callback may have inserted first.
    const { data: raceRow } = await service
      .from('integrations')
      .select('id')
      .eq('project_id', projectId)
      .eq('type', 'github')
      .eq('status', 'active')
      .maybeSingle()
    if (raceRow) return { resolved: true }
    chatServerLog('error', 'github_status_identity_insert_failed', {
      err: error,
      userId,
      projectId,
      installationId: chosenInstallationId,
    })
    return { resolved: false }
  }

  chatServerLog('info', 'github_status_linked_via_identity', {
    userId,
    projectId,
    installationId: chosenInstallationId,
    githubLogin: identity.github_login,
  })
  return { resolved: true }
}
