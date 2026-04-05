import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/types'
import { decrypt } from '@/lib/encryption'
import { getInstallationToken } from '@/lib/github'
import { primaryGithubRepoFullName } from '@/lib/github-integration-config'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'
import { INTEGRATION_REGISTRY } from '@/lib/integrations/registry'
import { fetchIntegrationDocs } from '@/lib/integrations/docs'
import { getLangSmithTracingClient } from '@/lib/langsmith-ai'
import { traceable } from 'langsmith/traceable'
import { createResearchSandbox, teardownSandbox } from './sandbox'
import { runResearchLoop } from './agent'
import { tracedRunCodebaseExplorationAgent } from './codebase-exploration-agent'
import { mergeIntegrationAndCodebase } from './merge-research-report'
import type {
  ResearchReport,
  IntegrationCredentials,
  IntegrationResearchReport,
} from './types'
import { emptyCodebaseExploration } from './types'
import type { ProgressCallback } from '@/lib/chat/agent-actions'

export type { ResearchReport }

const lsClient = getLangSmithTracingClient()

async function fetchIntegrationDocsBundle(input: {
  types: string[]
}): Promise<Record<string, string>> {
  const docs = await Promise.all(
    input.types.map(async (type) => [type, await fetchIntegrationDocs(type)] as const),
  )
  return Object.fromEntries(docs)
}

const tracedFetchIntegrationDocs = traceable(fetchIntegrationDocsBundle, {
  name: 'research_fetch_integration_docs',
  ...(lsClient ? { client: lsClient } : {}),
  processInputs: (i) => ({ integrationTypes: i.types, count: i.types.length }),
  processOutputs: (out) => ({
    docKeys: Object.keys(out),
    docSizes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
  }),
})

function fallbackIntegrationReport(appUrl: string, reason: string): IntegrationResearchReport {
  return {
    summary: reason,
    findings: [],
    recommendedFlows: [
      `Homepage smoke test — open ${appUrl} and verify critical UI`,
      'Primary navigation — exercise main routes and links',
      'Core user journey — sign-in, forms, or checkout if applicable',
    ],
    integrationsCovered: [],
    integrationsSkipped: [],
  }
}

async function runIntegrationResearchTrack(input: {
  supabase: SupabaseClient<Database>
  projectId: string
  appUrl: string
  onProgress?: ProgressCallback
}): Promise<IntegrationResearchReport> {
  const { supabase, projectId, appUrl, onProgress } = input

  const { data: integrations } = await supabase
    .from('integrations')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'active')

  if (!integrations || integrations.length === 0) {
    return fallbackIntegrationReport(
      appUrl,
      'No integrations are connected. Recommendations are based on general best practices for the application URL.',
    )
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
            const primary = primaryGithubRepoFullName(repos)
            if (primary) envVars.GITHUB_REPOS = primary
          }
          break
        }
        case 'posthog': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            const host = (config.api_host as string) || 'https://us.posthog.com'
            creds.push({
              type,
              credentials: {
                api_key: apiKey,
                project_id: config.posthog_project_id as string,
                api_host: host,
              },
            })
            envVars.POSTHOG_HOST = host.replace(/\/$/, '')
            envVars.POSTHOG_PROJECT_ID = config.posthog_project_id as string
          }
          break
        }
        case 'sentry': {
          const authTokenEncrypted = config.auth_token_encrypted as string
          if (authTokenEncrypted) {
            const authToken = decrypt(authTokenEncrypted)
            creds.push({
              type,
              credentials: {
                auth_token: authToken,
                organization_slug: config.organization_slug as string,
                project_slug: config.project_slug as string,
              },
            })
            envVars.SENTRY_ORG_SLUG = config.organization_slug as string
            envVars.SENTRY_PROJECT_SLUG = config.project_slug as string
          }
          break
        }
        case 'langsmith': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            creds.push({
              type,
              credentials: {
                api_key: apiKey,
                project_name: (config.project_name as string) || '',
              },
            })
            if (config.project_name) envVars.LANGSMITH_PROJECT_NAME = config.project_name as string
          }
          break
        }
        case 'braintrust': {
          const apiKeyEncrypted = config.api_key_encrypted as string
          if (apiKeyEncrypted) {
            const apiKey = decrypt(apiKeyEncrypted)
            creds.push({
              type,
              credentials: {
                api_key: apiKey,
                project_name: (config.braintrust_project_name as string) || '',
              },
            })
            if (config.braintrust_project_name) {
              envVars.BRAINTRUST_PROJECT_NAME = config.braintrust_project_name as string
            }
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
      summary:
        'Integrations are connected but credentials could not be resolved. Recommendations are based on general best practices.',
      findings: [],
      recommendedFlows: ['Homepage smoke test', 'Primary navigation flow', 'Core form submission'],
      integrationsCovered: [],
      integrationsSkipped: docsToFetch,
    }
  }

  const integrationDocs = await tracedFetchIntegrationDocs({ types: docsToFetch })

  async function createSandboxWithEnv(input: {
    creds: IntegrationCredentials[]
    env: Record<string, string>
  }) {
    return createResearchSandbox(input.creds, input.env)
  }

  const tracedCreateSandbox = traceable(createSandboxWithEnv, {
    name: 'research_create_sandbox',
    ...(lsClient ? { client: lsClient } : {}),
    processInputs: (inputs) => ({
      integrationTypes: inputs.creds.map((x) => x.type),
      credentialSlotCount: inputs.creds.length,
      envKeys: Object.keys(inputs.env),
    }),
  })
  const sandbox = await tracedCreateSandbox({ creds, env: envVars })

  try {
    return await runResearchLoop({
      appUrl,
      integrationDocs,
      integrationEnvVars: envVars,
      sandbox,
      onProgress,
    })
  } catch (e) {
    console.error('Integration research loop failed:', e)
    return fallbackIntegrationReport(
      appUrl,
      `Integration research encountered an error: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    await teardownSandbox(sandbox)
  }
}

async function runResearchAgentCore(
  supabase: SupabaseClient<Database>,
  projectId: string,
  appUrl: string,
  onProgress?: ProgressCallback,
): Promise<ResearchReport> {
  const ghReady = await getGithubIntegrationReady(supabase, projectId)

  if (!ghReady.ok) {
    return {
      summary: ghReady.reason,
      findings: [],
      recommendedFlows: [
        `Smoke test — load ${appUrl} and verify primary UI`,
        'Complete GitHub setup to unlock repository-aware test planning',
      ],
      integrationsCovered: [],
      integrationsSkipped: ['github'],
      codebaseExploration: emptyCodebaseExploration({
        summary: ghReady.reason,
        truncationWarnings: ['GitHub integration incomplete'],
      }),
    }
  }

  onProgress?.({
    actionId: 'codebase-exploration',
    integration: 'codebase',
    label: 'Exploring repository structure',
    detail: `Analyzing ${ghReady.repoFullName}`,
    status: 'running',
  })

  const [integrationOutcome, codebaseOutcome] = await Promise.allSettled([
    runIntegrationResearchTrack({ supabase, projectId, appUrl, onProgress }),
    tracedRunCodebaseExplorationAgent({
      installationId: ghReady.installationId,
      repoFullName: ghReady.repoFullName,
    }),
  ])

  const integrationReport: IntegrationResearchReport =
    integrationOutcome.status === 'fulfilled'
      ? integrationOutcome.value
      : fallbackIntegrationReport(
          appUrl,
          `Integration research failed: ${integrationOutcome.reason instanceof Error ? integrationOutcome.reason.message : String(integrationOutcome.reason)}`,
        )

  let codebase: ReturnType<typeof emptyCodebaseExploration>
  if (codebaseOutcome.status === 'fulfilled') {
    codebase = codebaseOutcome.value
    onProgress?.({
      actionId: 'codebase-exploration',
      integration: 'codebase',
      label: 'Repository analysis complete',
      detail: `${codebase.confidence} confidence — found ${codebase.inferredUserFlows.length} user flows`,
      status: 'complete',
    })
  } else {
    const err =
      codebaseOutcome.reason instanceof Error
        ? codebaseOutcome.reason.message
        : String(codebaseOutcome.reason)
    console.error('Codebase exploration failed:', err)
    codebase = emptyCodebaseExploration({
      summary: `Repository exploration failed: ${err}`,
      truncationWarnings: [err],
    })
    onProgress?.({
      actionId: 'codebase-exploration',
      integration: 'codebase',
      label: 'Repository exploration failed',
      detail: err.slice(0, 120),
      status: 'error',
    })
  }

  onProgress?.({
    actionId: 'merge-reports',
    integration: 'system',
    label: 'Merging research findings',
    detail: 'Combining integration data with codebase analysis',
    status: 'running',
  })

  const merged = mergeIntegrationAndCodebase(integrationReport, codebase)

  onProgress?.({
    actionId: 'merge-reports',
    integration: 'system',
    label: 'Research complete',
    detail: `${merged.findings.length} findings, ${merged.recommendedFlows.length} recommended flows`,
    status: 'complete',
  })

  return merged
}

export const runResearchAgent = traceable(runResearchAgentCore, {
  name: 'verona_run_research_agent',
  ...(lsClient ? { client: lsClient } : {}),
  processInputs: (inputs) => {
    const args = 'args' in inputs && Array.isArray(inputs.args) ? inputs.args : []
    const projectId = typeof args[1] === 'string' ? args[1] : undefined
    const appUrl = typeof args[2] === 'string' ? args[2] : undefined
    return { projectId, appUrl, hasProgressCallback: typeof args[3] === 'function' }
  },
  processOutputs: (out) => ({
    summaryPreview: out.summary?.slice(0, 400),
    findingsCount: out.findings.length,
    integrationsCovered: out.integrationsCovered,
    integrationsSkipped: out.integrationsSkipped,
    codebaseConfidence: out.codebaseExploration?.confidence,
  }),
})
