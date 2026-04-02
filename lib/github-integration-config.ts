import type { Json } from '@/lib/supabase/types'

/**
 * GitHub integration stores `config.repos` as an array for historical reasons.
 * The product only supports exactly one repository per project; normalize reads accordingly.
 */
export function primaryGithubRepoFullName(
  repos: Array<Record<string, Json>> | undefined | null,
): string | null {
  const first = repos?.find((r) => typeof r.full_name === 'string' && r.full_name.length > 0)
  return (first?.full_name as string) ?? null
}

export function normalizeGithubReposForStorage(
  repos: Array<Record<string, Json>>,
): Array<Record<string, Json>> {
  const name = primaryGithubRepoFullName(repos)
  if (!name) return []
  const match = repos.find((r) => r.full_name === name)
  return match ? [match] : []
}
