import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getServerUser } from '@/lib/supabase/server-user'
import type { Json } from '@/lib/supabase/types'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'
import {
  exchangeOAuthCode,
  getGitHubUser,
  listUserInstallations,
  type GitHubUserInstallation,
} from '@/lib/github'
import { encrypt } from '@/lib/encryption'
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * Post-install setup URL + user-auth callback for the Verona GitHub App.
 *
 * Requires the GitHub App to have "Request user authorization (OAuth)
 * during installation" enabled, so every trip through
 * `github.com/apps/<slug>/installations/new` returns a `code` in the
 * query string. We exchange that code for a user access token, then
 * cross-check the query's `installation_id` against
 * `GET /user/installations` — which is scoped to the authenticated
 * GitHub user by the OAuth token, so we can never link an installation
 * the user doesn't actually own.
 *
 * The old "no-code, trust the query" path has been removed; a missing
 * `code` indicates a misconfigured GitHub App and surfaces a 400 rather
 * than silently writing an unverified installation row.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) {
    return NextResponse.redirect(new URL('/login', request.nextUrl.origin))
  }

  const code = request.nextUrl.searchParams.get('code')
  const installationIdRaw = request.nextUrl.searchParams.get('installation_id')
  const setupAction = request.nextUrl.searchParams.get('setup_action')
  const state = request.nextUrl.searchParams.get('state')

  if (!state) {
    return NextResponse.json({ error: 'Missing state (project id)' }, { status: 400 })
  }

  if (!code) {
    chatServerLog('error', 'github_callback_missing_oauth_code', {
      userId: user.id,
      installationIdFromQuery: installationIdRaw,
      setupAction,
    })
    return NextResponse.json(
      {
        error:
          'GitHub did not return an authorization code. Check that the GitHub App has "Request user authorization (OAuth) during installation" enabled.',
      },
      { status: 400 },
    )
  }

  let projectId = state
  let returnTo: string | null = null
  if (state.includes('::')) {
    const parts = state.split('::')
    projectId = parts[0]
    returnTo = parts.slice(1).join('::')
  }

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

  const installationIdFromQuery =
    installationIdRaw && /^\d+$/.test(installationIdRaw)
      ? Number(installationIdRaw)
      : null

  let resolvedInstallationId: number
  let linkedGitHubIdentity: { id: number; login: string }

  try {
    const token = await exchangeOAuthCode(code)
    const [ghUser, ghInstallations] = await Promise.all([
      getGitHubUser(token.accessToken),
      listUserInstallations(token.accessToken),
    ])
    linkedGitHubIdentity = { id: ghUser.id, login: ghUser.login }

    const picked = pickInstallation({
      installationIdFromQuery,
      userInstallations: ghInstallations,
    })

    if (picked === null) {
      chatServerLog('warn', 'github_callback_no_installation_candidate', {
        userId: user.id,
        projectId,
        installationIdFromQuery,
        userInstallationCount: ghInstallations.length,
        setupAction,
      })
      // Redirect back with a structured marker so the UI can prompt the
      // user to finish installing or pick an installation. The chat
      // page's settings overlay is the natural landing place.
      const redirectPath = returnTo || `/projects/${projectId}/chat?settings=1`
      const redirect = new URL(redirectPath, request.nextUrl.origin)
      redirect.searchParams.set('github', 'needs_installation')
      return NextResponse.redirect(redirect)
    }

    resolvedInstallationId = picked

    // Persist the GitHub user identity + encrypted tokens so later calls
    // (the status endpoint, future settings views) can re-use it without
    // driving the user through OAuth again.
    const service = createServiceRoleClient()
    try {
      await service
        .from('user_github_identities')
        .upsert(
          {
            user_id: user.id,
            github_user_id: ghUser.id,
            github_login: ghUser.login,
            access_token_encrypted: encrypt(token.accessToken),
            refresh_token_encrypted: token.refreshToken
              ? encrypt(token.refreshToken)
              : null,
            access_token_expires_at: token.accessTokenExpiresAt,
            refresh_token_expires_at: token.refreshTokenExpiresAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        )
    } catch (e) {
      // Failing to persist the identity should NOT block the main
      // connect flow — the integration row is still the authoritative
      // "you are connected" signal. Log for debugging.
      chatServerLog('warn', 'github_callback_identity_persist_failed', {
        err: e,
        userId: user.id,
        githubLogin: ghUser.login,
      })
    }
  } catch (e) {
    chatServerLog('error', 'github_callback_oauth_failed', {
      err: e,
      userId: user.id,
      projectId,
    })
    return NextResponse.json(
      {
        error:
          'GitHub authorization failed. Please try reconnecting in a moment.',
      },
      { status: 500 },
    )
  }

  const config: Json = {
    installation_id: resolvedInstallationId,
    setup_action: setupAction,
    repo: null,
    linked_github_user_id: linkedGitHubIdentity.id,
    linked_github_login: linkedGitHubIdentity.login,
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
    await clearResearchReportsForProject(supabase, projectId)
  } else {
    const { error } = await supabase.from('integrations').insert({
      project_id: projectId,
      type: 'github',
      config,
      status: 'active',
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await clearResearchReportsForProject(supabase, projectId)
  }

  chatServerLog('info', 'github_callback_linked', {
    userId: user.id,
    projectId,
    installationId: resolvedInstallationId,
    setupAction,
    githubLogin: linkedGitHubIdentity.login,
  })

  const redirectPath = returnTo || `/projects/${projectId}/chat?settings=1`
  const redirect = new URL(redirectPath, request.nextUrl.origin)
  redirect.searchParams.set('github', 'connected')
  return NextResponse.redirect(redirect)
}

/**
 * Pick the installation to link. Returns `null` if none are viable and
 * the caller should surface an "install / pick" prompt to the user.
 *
 * Decision order:
 *   1. If the query carries an `installation_id`, trust it only if the
 *      authenticated GitHub user actually has access to it. This is the
 *      cross-tenant guard — a tampered URL that references another
 *      customer's installation won't pass this check.
 *   2. Else, if the user has exactly one installation accessible, pick it.
 *      Covers the pure-OAuth round-trip where no installation_id query
 *      param is present.
 *   3. Otherwise return null (no installation / multiple with no hint).
 */
function pickInstallation(opts: {
  installationIdFromQuery: number | null
  userInstallations: GitHubUserInstallation[]
}): number | null {
  const { installationIdFromQuery, userInstallations } = opts
  const reachable = new Set(userInstallations.map((i) => i.id))

  if (installationIdFromQuery !== null) {
    return reachable.has(installationIdFromQuery) ? installationIdFromQuery : null
  }
  if (userInstallations.length === 1) {
    return userInstallations[0].id
  }
  return null
}
