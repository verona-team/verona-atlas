import { App } from "@octokit/app"
import { Octokit } from "@octokit/rest"
import type { Endpoints } from "@octokit/types"

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

/** Get the GitHub App installation URL for the user to install */
export function getInstallUrl(): string {
  return `https://github.com/apps/${process.env.GITHUB_APP_SLUG || "atlas-qa"}/installations/new`
}
