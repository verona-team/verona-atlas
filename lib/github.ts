import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import type { Endpoints } from "@octokit/types"
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

type RepoCommit = Endpoints["GET /repos/{owner}/{repo}/commits"]["response"]["data"][number]

export async function fetchRecentCommits(
  installationId: number,
  repo: string,
  sinceDays: number = 7,
): Promise<Array<{ sha: string; message: string; date: string; author: string }>> {
  const octokit = await getInstallationOctokit(installationId)
  const [owner, repoName] = repo.split("/")
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()

  const { data: commits } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner,
    repo: repoName,
    since,
    per_page: 30,
  })

  return commits.map((c: RepoCommit) => ({
    sha: c.sha,
    message: c.commit.message,
    date: c.commit.author?.date ?? "",
    author: c.commit.author?.name ?? "",
  }))
}

export async function fetchCommitDiff(
  installationId: number,
  repo: string,
  sha: string,
): Promise<string> {
  const octokit = await getInstallationOctokit(installationId)
  const [owner, repoName] = repo.split("/")

  const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner,
    repo: repoName,
    ref: sha,
    mediaType: { format: "diff" },
  })

  return data as unknown as string
}

export function getInstallUrl(): string {
  return `https://github.com/apps/${process.env.GITHUB_APP_SLUG || "atlas-qa"}/installations/new`
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
