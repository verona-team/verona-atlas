import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { primaryGithubRepoFullName } from '@/lib/github-integration-config'

export type GithubReadyState =
  | { ok: true; installationId: number; repoFullName: string }
  | { ok: false; reason: string }

export async function getGithubIntegrationReady(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<GithubReadyState> {
  const { data: integration } = await supabase
    .from('integrations')
    .select('config, status')
    .eq('project_id', projectId)
    .eq('type', 'github')
    .eq('status', 'active')
    .maybeSingle()

  if (!integration) {
    return { ok: false, reason: 'GitHub is not connected. Connect GitHub and select a repository in project setup.' }
  }

  const config = integration.config as Record<string, Json>
  const installationId = config.installation_id as number | undefined
  const repos = (config.repos as Array<Record<string, Json>>) || []
  const repoFullName = primaryGithubRepoFullName(repos)

  if (!installationId) {
    return { ok: false, reason: 'GitHub installation is incomplete. Reconnect GitHub from project setup.' }
  }

  if (!repoFullName) {
    return { ok: false, reason: 'Select a GitHub repository for this project in setup or settings.' }
  }

  return { ok: true, installationId, repoFullName }
}

/** Clear cached research reports so the next chat/cron run recomputes (e.g. after repo change). */
export async function clearResearchReportsForProject(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<void> {
  await supabase
    .from('chat_sessions')
    .update({
      research_report: null,
      updated_at: new Date().toISOString(),
    })
    .eq('project_id', projectId)
}
