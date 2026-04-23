import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import { createHmac, timingSafeEqual } from "crypto"

type InstallationOctokit = InstanceType<typeof Octokit>

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
