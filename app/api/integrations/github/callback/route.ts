import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getServerUser } from '@/lib/supabase/server-user'
import type { Json } from '@/lib/supabase/types'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'
import {
  exchangeOAuthCode,
  getAppSlug,
  getGitHubUser,
  listUserInstallations,
  type GitHubUserInstallation,
} from '@/lib/github'
import { encrypt } from '@/lib/encryption'
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * Post-install / post-authorize callback for the Verona GitHub App.
 *
 * This single route handles two entry paths:
 *
 *   1. Pure OAuth authorize (primary): the user clicks "Connect
 *      GitHub" and we send them through
 *      `https://github.com/login/oauth/authorize`. GitHub always
 *      returns a `code` here regardless of whether the app is
 *      already installed on their GitHub account — this is what
 *      fixes the "infinite loading on a second Verona account"
 *      bug (the old install URL silently showed a "configure" page
 *      instead of redirecting back when the app was already
 *      installed).
 *
 *   2. App install flow: the user's first time installing the app.
 *      GitHub hits us with `code` + `installation_id` once the
 *      install completes. Same code path — we exchange the code
 *      and match the installation_id against the user's reachable
 *      installations.
 *
 * Requires the GitHub App to have "Request user authorization
 * (OAuth) during installation" enabled, so both paths return a
 * `code`. We exchange it for a user access token, then cross-check
 * any query `installation_id` against `GET /user/installations`
 * (which is scoped to the authenticated GitHub user by the OAuth
 * token) so we can never link an installation the user doesn't
 * actually own.
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

  // Exchange the OAuth code + fetch the user's identity and
  // reachable installations up front. We persist the identity
  // unconditionally (before any routing decision) so that:
  //   - If we end up surfacing a picker to the user for the
  //     multi-installation case, the picker's backend call can
  //     re-use this token without a second OAuth round trip.
  //   - The status endpoint's auto-link layer becomes usable for
  //     subsequent polls even if this request itself doesn't
  //     resolve to a single installation.
  let ghUser: { id: number; login: string }
  let ghInstallations: GitHubUserInstallation[]
  try {
    const token = await exchangeOAuthCode(code)
    ;[ghUser, ghInstallations] = await Promise.all([
      getGitHubUser(token.accessToken),
      listUserInstallations(token.accessToken),
    ])

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
      // Failing to persist the identity should NOT block the flow —
      // the integration row is still the authoritative "you are
      // connected" signal. Log for debugging.
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

  const picked = pickInstallation({
    installationIdFromQuery,
    userInstallations: ghInstallations,
  })

  // 0-install case: the authenticated GitHub user doesn't have
  // the Verona app installed anywhere. Bounce the popup into the
  // actual install flow so they can install the app. GitHub will
  // re-hit this same callback with `installation_id` + a fresh
  // `code` once the install completes, at which point we take the
  // normal auto-link path below.
  if (picked === null && ghInstallations.length === 0) {
    chatServerLog('info', 'github_callback_redirect_to_install', {
      userId: user.id,
      projectId,
      githubLogin: ghUser.login,
    })
    const slug = await getAppSlug()
    const installUrl = new URL(
      `https://github.com/apps/${slug}/installations/new`,
    )
    const nextState = returnTo ? `${projectId}::${returnTo}` : projectId
    installUrl.searchParams.set('state', nextState)
    return NextResponse.redirect(installUrl)
  }

  // Multi-install case: the user has the app on more than one
  // GitHub account/org and we have no hint which one to pick.
  // Surface a picker in the UI rather than guessing. The settings
  // overlay reads the `github=pick_installation` marker and calls
  // `/api/integrations/github/installations` + the
  // `link-installation` endpoint to complete the connect.
  if (picked === null) {
    chatServerLog('warn', 'github_callback_ambiguous_installations', {
      userId: user.id,
      projectId,
      userInstallationCount: ghInstallations.length,
      setupAction,
    })
    const redirectPath = returnTo || `/projects/${projectId}/chat?settings=1`
    const redirect = new URL(redirectPath, request.nextUrl.origin)
    redirect.searchParams.set('github', 'pick_installation')
    return NextResponse.redirect(redirect)
  }

  const resolvedInstallationId = picked

  const config: Json = {
    installation_id: resolvedInstallationId,
    setup_action: setupAction,
    repo: null,
    linked_github_user_id: ghUser.id,
    linked_github_login: ghUser.login,
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
    githubLogin: ghUser.login,
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
 *      param is present — this is the path that fixes the bug where a
 *      second Verona account couldn't connect GitHub because the app
 *      was already installed on the same GitHub user.
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
