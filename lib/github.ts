import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createHmac, timingSafeEqual } from "crypto"

type InstallationOctokit = InstanceType<typeof Octokit>

/**
 * User-level OAuth tokens obtained via the GitHub App's
 * "Request user authorization (OAuth) during installation" flow.
 *
 * These are fundamentally different from the App-level JWT we sign with
 * GITHUB_APP_PRIVATE_KEY: the App JWT authenticates as the App itself
 * (can see all installations); the user token authenticates as the human
 * who just went through the install/authorize popup (can only see the
 * installations they personally have access to).
 *
 * We use user tokens to verify installation ownership via
 * `GET /user/installations`, which is how we safely link installations
 * that aren't yet recorded in any of the caller's orgs.
 */
export interface GitHubUserToken {
  accessToken: string
  /** ISO timestamp or null if the token does not expire. */
  accessTokenExpiresAt: string | null
  refreshToken: string | null
  /** ISO timestamp or null if no refresh token was issued. */
  refreshTokenExpiresAt: string | null
}

export interface GitHubUserProfile {
  id: number
  login: string
}

export interface GitHubUserInstallation {
  id: number
  accountLogin: string
  accountType: string
}

function getApp(): App<{ Octokit: typeof Octokit }> {
  return new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, "base64").toString(
      "utf8",
    ),
    Octokit,
  })
}

let _cachedAppSlug: string | null = null

/**
 * Resolve the GitHub App's slug dynamically via the authenticated GET /app
 * endpoint. Falls back to GITHUB_APP_SLUG env var if the API call fails.
 * The result is cached for the lifetime of the process.
 */
export async function getAppSlug(): Promise<string> {
  if (_cachedAppSlug) return _cachedAppSlug

  if (process.env.GITHUB_APP_SLUG) {
    _cachedAppSlug = process.env.GITHUB_APP_SLUG
    return _cachedAppSlug
  }

  try {
    const app = getApp()
    const { data } = await app.octokit.request("GET /app")
    if (data?.slug) {
      _cachedAppSlug = data.slug
      return _cachedAppSlug
    }
  } catch (e) {
    console.warn("Failed to fetch GitHub App slug from API:", e)
  }

  return "atlas-qa"
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const app = getApp()
  const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  })
  return data.token
}

export async function getInstallationOctokit(
  installationId: number,
): Promise<InstallationOctokit> {
  const app = getApp()
  return app.getInstallationOctokit(installationId)
}

export interface GitHubRepo {
  fullName: string
  private: boolean
  defaultBranch: string
}

export async function listInstallationRepos(
  installationId: number,
): Promise<GitHubRepo[]> {
  const octokit = await getInstallationOctokit(installationId)
  const repos: GitHubRepo[] = []
  let page = 1

  while (true) {
    const { data } = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    })

    for (const repo of data.repositories) {
      repos.push({
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch ?? "main",
      })
    }

    if (repos.length >= data.total_count) break
    page++
  }

  return repos
}

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return false

  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex")

  const sigBuf = Buffer.from(signature)
  const expectedBuf = Buffer.from(expected)

  if (sigBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(sigBuf, expectedBuf)
}

/**
 * Exchange a one-time OAuth `code` returned by the GitHub App install /
 * user-auth redirect for a user access token (optionally plus a refresh
 * token). Requires `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`.
 *
 * GitHub App user tokens are short-lived (8 hours) with 6-month refresh
 * tokens. If the app's "Expire user authorization tokens" setting is OFF,
 * `accessTokenExpiresAt` / `refreshTokenExpiresAt` will be null.
 */
export async function exchangeOAuthCode(code: string): Promise<GitHubUserToken> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not configured",
    )
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  })

  if (!res.ok) {
    throw new Error(
      `GitHub OAuth token exchange failed (HTTP ${res.status})`,
    )
  }

  const json = (await res.json()) as {
    access_token?: string
    token_type?: string
    expires_in?: number
    refresh_token?: string
    refresh_token_expires_in?: number
    error?: string
    error_description?: string
  }

  if (!json.access_token) {
    throw new Error(
      `GitHub OAuth token exchange rejected: ${json.error ?? "unknown"}${
        json.error_description ? " — " + json.error_description : ""
      }`,
    )
  }

  const now = Date.now()
  return {
    accessToken: json.access_token,
    accessTokenExpiresAt:
      typeof json.expires_in === "number"
        ? new Date(now + json.expires_in * 1000).toISOString()
        : null,
    refreshToken: json.refresh_token ?? null,
    refreshTokenExpiresAt:
      typeof json.refresh_token_expires_in === "number"
        ? new Date(now + json.refresh_token_expires_in * 1000).toISOString()
        : null,
  }
}

/**
 * Refresh an expired user access token. Only works if the App is
 * configured to expire user tokens and a `refreshToken` was captured at
 * install time. On failure (e.g. refresh token itself expired / revoked)
 * the user must be prompted to re-authorize the app.
 */
export async function refreshUserToken(
  refreshToken: string,
): Promise<GitHubUserToken> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not configured",
    )
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    throw new Error(`GitHub OAuth token refresh failed (HTTP ${res.status})`)
  }

  const json = (await res.json()) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    refresh_token_expires_in?: number
    error?: string
    error_description?: string
  }

  if (!json.access_token) {
    throw new Error(
      `GitHub OAuth token refresh rejected: ${json.error ?? "unknown"}${
        json.error_description ? " — " + json.error_description : ""
      }`,
    )
  }

  const now = Date.now()
  return {
    accessToken: json.access_token,
    accessTokenExpiresAt:
      typeof json.expires_in === "number"
        ? new Date(now + json.expires_in * 1000).toISOString()
        : null,
    // GitHub may or may not rotate the refresh token on refresh; keep
    // whichever one the caller had if a new one wasn't returned.
    refreshToken: json.refresh_token ?? null,
    refreshTokenExpiresAt:
      typeof json.refresh_token_expires_in === "number"
        ? new Date(now + json.refresh_token_expires_in * 1000).toISOString()
        : null,
  }
}

/**
 * Fetch the authenticated GitHub user's basic profile. Used to record
 * `github_user_id` + `github_login` alongside the user's stored tokens
 * for audit + future "Connected as @octocat" UX.
 */
export async function getGitHubUser(
  userAccessToken: string,
): Promise<GitHubUserProfile> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!res.ok) {
    throw new Error(`GET /user failed (HTTP ${res.status})`)
  }
  const json = (await res.json()) as { id?: number; login?: string }
  if (typeof json.id !== "number" || typeof json.login !== "string") {
    throw new Error("GET /user returned an unexpected payload shape")
  }
  return { id: json.id, login: json.login }
}

/**
 * List GitHub App installations the **authenticated user** can access.
 *
 * Crucially different from `GET /app/installations` (App-level) which
 * returns every customer's installation — calling the user-scoped
 * endpoint with a user token is what makes cross-tenant auto-linking
 * safe: we only see installations this specific human can actually reach
 * on GitHub's side.
 */
export async function listUserInstallations(
  userAccessToken: string,
): Promise<GitHubUserInstallation[]> {
  const out: GitHubUserInstallation[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    )
    if (!res.ok) {
      throw new Error(`GET /user/installations failed (HTTP ${res.status})`)
    }
    const json = (await res.json()) as {
      total_count?: number
      installations?: Array<{
        id: number
        account?: { login?: string; type?: string } | null
      }>
    }
    const installations = json.installations ?? []
    for (const inst of installations) {
      out.push({
        id: inst.id,
        accountLogin: inst.account?.login ?? "",
        accountType: inst.account?.type ?? "",
      })
    }
    const total = json.total_count ?? out.length
    if (out.length >= total || installations.length === 0) break
    page++
  }
  return out
}
