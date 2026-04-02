import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { decrypt } from '@/lib/encryption'
import { getInstallationToken } from '@/lib/github'
import { INTEGRATION_REGISTRY } from '@/lib/integrations/registry'
import { fetchIntegrationDocs } from '@/lib/integrations/docs'
import { createResearchSandbox, teardownSandbox } from './sandbox'
import { runResearchLoop } from './agent'
import type { ResearchReport, IntegrationCredentials } from './types'

export type { ResearchReport }

export async function runResearchAgent(
  supabase: SupabaseClient<Database>,
  projectId: string,
  appUrl: string,
): Promise<ResearchReport> {
  const { data: integrations } = await supabase
    .from('integrations')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'active')

  if (!integrations || integrations.length === 0) {
    return {
      summary: 'No integrations are connected. Recommendations are based on general best practices for the application URL.',
      findings: [],
      recommendedFlows: [
        'Homepage smoke test — verify the site loads and key elements are visible',
        'Primary navigation — click through all main nav links and verify pages load',
        'Core form submission — find and test the main form (signup, contact, search)',
        'Mobile responsive check — verify layout at common mobile breakpoints',
      ],
      integrationsCovered: [],
      integrationsSkipped: [],
    }
  }

  const creds: IntegrationCredentials[] = []
  const envVars: Record<string, string> = {}
  const docsToFetch: string[] = []

  for (const integration of integrations) {
    const config = integration.config as Record<string, Json>
    const type = integration.type

    if (!INTEGRATION_REGISTRY[type]) continue

    try {
      switch (type) {
        case 'github': {
          const installationId = config.installation_id as number
          if (installationId) {
            const token = await getInstallationToken(installationId)
            creds.push({ type, credentials: { installation_token: token } })
            const repos = (config.repos as Array<Record<string, Json>>) || []
            envVars.GITHUB_REPOS = repos.map((r) => r.full_name as string).filter(Boolean).join(',')
          }
          break
        }
        case 'posthog': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            const host = (config.api_host as string) || 'https://us.posthog.com'
            creds.push({ type, credentials: { api_key: apiKey, project_id: config.posthog_project_id as string, api_host: host } })
            envVars.POSTHOG_HOST = host.replace(/\/$/, '')
            envVars.POSTHOG_PROJECT_ID = config.posthog_project_id as string
          }
          break
        }
        case 'sentry': {
          const authTokenEncrypted = config.auth_token_encrypted as string
          if (authTokenEncrypted) {
            const authToken = decrypt(authTokenEncrypted)
            creds.push({ type, credentials: { auth_token: authToken, organization_slug: config.organization_slug as string, project_slug: config.project_slug as string } })
            envVars.SENTRY_ORG_SLUG = config.organization_slug as string
            envVars.SENTRY_PROJECT_SLUG = config.project_slug as string
          }
          break
        }
        case 'langsmith': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            creds.push({ type, credentials: { api_key: apiKey, project_name: (config.project_name as string) || '' } })
            if (config.project_name) envVars.LANGSMITH_PROJECT_NAME = config.project_name as string
          }
          break
        }
        case 'braintrust': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            creds.push({ type, credentials: { api_key: apiKey, project_name: (config.braintrust_project_name as string) || '' } })
            if (config.braintrust_project_name) envVars.BRAINTRUST_PROJECT_NAME = config.braintrust_project_name as string
          }
          break
        }
      }
      docsToFetch.push(type)
    } catch (e) {
      console.warn(`Failed to prepare credentials for ${type}:`, e)
    }
  }

  if (creds.length === 0) {
    return {
      summary: 'Integrations are connected but credentials could not be resolved. Recommendations are based on general best practices.',
      findings: [],
      recommendedFlows: [
        'Homepage smoke test',
        'Primary navigation flow',
        'Core form submission',
      ],
      integrationsCovered: [],
      integrationsSkipped: docsToFetch,
    }
  }

  const docs = await Promise.all(
    docsToFetch.map(async (type) => [type, await fetchIntegrationDocs(type)] as const),
  )
  const integrationDocs = Object.fromEntries(docs)

  const sandbox = await createResearchSandbox(creds)

  try {
    const report = await runResearchLoop({
      appUrl,
      integrationDocs,
      integrationEnvVars: envVars,
      sandbox,
    })
    return report
  } finally {
    await teardownSandbox(sandbox)
  }
}
