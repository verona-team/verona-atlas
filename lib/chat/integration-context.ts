import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { fetchRecentCommits } from '@/lib/github'
import { fetchSessionRecordings, fetchErrorEvents, fetchTopPages } from '@/lib/posthog'
import { decrypt } from '@/lib/encryption'

interface IntegrationData {
  commits: Array<{ sha: string; message: string; date: string; author: string }>
  sessionRecordings: unknown[]
  errorEvents: unknown[]
  topPages: unknown[]
  sentryIssues: unknown[]
  existingTemplates: Array<{ name: string; description: string | null }>
}

export async function gatherIntegrationContext(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<IntegrationData> {
  const { data: integrations } = await supabase
    .from('integrations')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'active')

  const githubIntegration = integrations?.find((i) => i.type === 'github')
  const posthogIntegration = integrations?.find((i) => i.type === 'posthog')

  let commits: IntegrationData['commits'] = []
  if (githubIntegration) {
    try {
      const config = githubIntegration.config as Record<string, Json>
      const installationId = config.installation_id as number
      const repos = (config.repos as Array<Record<string, Json>>) || []
      if (installationId && repos.length > 0) {
        for (const repo of repos.slice(0, 3)) {
          const repoName = repo.full_name as string
          if (repoName) {
            const repoCommits = await fetchRecentCommits(installationId, repoName)
            commits.push(...repoCommits)
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch GitHub commits:', e)
    }
  }

  let sessionRecordings: unknown[] = []
  let errorEvents: unknown[] = []
  let topPages: unknown[] = []
  if (posthogIntegration) {
    try {
      const config = posthogIntegration.config as Record<string, Json>
      const apiKeyEncrypted = config.api_key_encrypted as string
      const posthogProjectId = config.posthog_project_id as string
      if (apiKeyEncrypted && posthogProjectId) {
        const apiKey = decrypt(apiKeyEncrypted)
        const phConfig = { apiKey, projectId: posthogProjectId }
        ;[sessionRecordings, errorEvents, topPages] = await Promise.all([
          fetchSessionRecordings(phConfig).catch(() => []),
          fetchErrorEvents(phConfig).catch(() => []),
          fetchTopPages(phConfig).catch(() => []),
        ])
      }
    } catch (e) {
      console.warn('Failed to fetch PostHog data:', e)
    }
  }

  const sentryIssues: unknown[] = []

  const { data: existingTemplates } = await supabase
    .from('test_templates')
    .select('name, description')
    .eq('project_id', projectId)

  return {
    commits,
    sessionRecordings,
    errorEvents,
    topPages,
    sentryIssues,
    existingTemplates: (existingTemplates ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    })),
  }
}
