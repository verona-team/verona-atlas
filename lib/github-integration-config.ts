import type { Json } from '@/lib/supabase/types'

/**
 * GitHub integration `config.repo` — exactly one linked repository per project.
 */
export type GithubLinkedRepo = {
  full_name: string
  private?: boolean
  default_branch?: string
}

export function parseGithubLinkedRepo(
  config: Record<string, Json>,
): GithubLinkedRepo | null {
  const repo = config.repo as GithubLinkedRepo | null | undefined
  if (!repo || typeof repo !== 'object') return null
  if (typeof repo.full_name !== 'string' || !repo.full_name) return null
  return repo
}

export function githubRepoFullName(config: Record<string, Json>): string | null {
  return parseGithubLinkedRepo(config)?.full_name ?? null
}

export function githubRepoToJson(repo: {
  full_name: string
  private: boolean
  default_branch: string
}): Json {
  return {
    full_name: repo.full_name,
    private: repo.private,
    default_branch: repo.default_branch,
  } as Json
}
