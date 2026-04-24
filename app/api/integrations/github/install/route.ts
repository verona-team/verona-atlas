import { type NextRequest, NextResponse } from 'next/server'
import { getAppSlug } from '@/lib/github'

/**
 * Entry point for the "Connect GitHub" button.
 *
 * This intentionally redirects to GitHub's pure OAuth authorize
 * endpoint (`https://github.com/login/oauth/authorize`) rather than
 * the App's install URL (`.../apps/<slug>/installations/new`).
 *
 * Why: the install URL is a one-time flow. If the user's GitHub
 * account already has the Verona app installed (e.g. from a previous
 * Verona project, or even a totally separate Verona org they signed
 * up to), GitHub treats `installations/new` as a "configure" call
 * instead of a redirect, shows the settings page, and never bounces
 * back to our callback — which means the chat page's connect card
 * polls forever and the user gets stuck in "Waiting for GitHub
 * authorization…". See bug "infinite loading on second account".
 *
 * The OAuth endpoint, by contrast, *always* round-trips with a
 * `code` parameter regardless of install state. In the callback we
 * exchange the code for a user token and then call
 * `GET /user/installations` to decide what to do:
 *
 *   - 0 installations → redirect the user to `installations/new` so
 *     they can install the app (genuinely first-time user).
 *   - 1 installation → auto-link. This is the path that fixes the
 *     "second account" bug — the user already has an installation
 *     and we reuse it instead of asking them to install again.
 *   - >1 installations → surface a picker in the UI.
 *
 * Requires `GITHUB_APP_CLIENT_ID` to be configured. If it's missing
 * we fall back to the old install URL so the app doesn't break for
 * environments that haven't finished the OAuth env setup yet; the
 * old infinite-loading behavior will then still apply for the
 * "already installed" case, but nothing else regresses.
 */
export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('project_id')
  const returnTo = request.nextUrl.searchParams.get('return_to')

  if (!projectId) {
    return NextResponse.json({ error: 'project_id required' }, { status: 400 })
  }

  const state = returnTo ? `${projectId}::${returnTo}` : projectId
  const clientId = process.env.GITHUB_APP_CLIENT_ID

  if (clientId) {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('state', state)
    // We deliberately don't set `redirect_uri` — GitHub will use the
    // App's configured "Callback URL" which is already pointed at
    // `/api/integrations/github/callback`. Setting it here would just
    // duplicate that config and add a foot-gun if the environment's
    // origin ever changes.
    return NextResponse.redirect(url)
  }

  // Fallback: no OAuth client configured → old install-URL behavior.
  const slug = await getAppSlug()
  const fallback = new URL(
    `https://github.com/apps/${slug}/installations/new`,
  )
  fallback.searchParams.set('state', state)
  return NextResponse.redirect(fallback)
}
