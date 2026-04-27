import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { parseGithubLinkedRepo } from '@/lib/github-integration-config'

/**
 * Sanitized shape returned to the client. Mirrors the JSON shape that
 * `/api/projects/:id/integrations` emits — kept identical so the API route
 * and SSR-side callers share a single source of truth.
 *
 * Secret config fields (tokens, API keys) are stripped via `sanitizeConfig`.
 */
export type ProjectIntegrationStatus = {
  id: string
  type: string
  status: string
  createdAt: string
  updatedAt: string
  meta: Record<string, Json>
}

/**
 * Read all integrations for `projectId` and return them in the
 * client-safe `ProjectIntegrationStatus` shape. Used by both the API route
 * (`GET /api/projects/:id/integrations`) and the chat page SSR pass so the
 * `<ProjectSetupCTA />` can render integration cards with their true
 * statuses on first paint, with no client-fetch flash.
 *
 * Authorization is left to the caller (RLS already constrains rows to the
 * authenticated user's projects, but server callers should additionally
 * verify org membership before invoking this helper).
 */
export async function listProjectIntegrations(
  supabase: SupabaseClient<Database>,
  projectId: string,
): Promise<ProjectIntegrationStatus[]> {
  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, type, status, config, created_at, updated_at')
    .eq('project_id', projectId)

  return (integrations || []).map((i) => {
    const config = i.config as Record<string, Json>
    return {
      id: i.id,
      type: i.type,
      status: i.status,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      meta: sanitizeConfig(i.type, config),
    }
  })
}

function sanitizeConfig(
  type: string,
  config: Record<string, Json>,
): Record<string, Json> {
  switch (type) {
    case 'github': {
      const repo = parseGithubLinkedRepo(config)
      return {
        installation_id: config.installation_id ?? null,
        repo: repo
          ? {
              full_name: repo.full_name,
              private: repo.private ?? null,
              default_branch: repo.default_branch ?? null,
            }
          : null,
      }
    }
    case 'posthog':
      return {
        posthog_project_id: config.posthog_project_id ?? null,
        api_host: config.api_host ?? null,
      }
    case 'sentry':
      return {
        organization_slug: config.organization_slug ?? null,
        project_slug: config.project_slug ?? null,
      }
    case 'langsmith':
      return {
        project_name: config.project_name ?? null,
        api_url: config.api_url ?? null,
      }
    case 'braintrust':
      return {
        project_name: config.project_name ?? null,
        api_url: config.api_url ?? null,
      }
    case 'slack':
      return {
        team_name: config.team_name ?? null,
        channel_id: config.channel_id ?? null,
        channel_name: config.channel_name ?? null,
      }
    default:
      return {}
  }
}
