export interface IntegrationSpec {
  docsUrl: string
  apiHosts: string[]
  buildAuthHeaders: (creds: Record<string, string>) => Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>>
  credentialKeys: string[]
}

export const INTEGRATION_REGISTRY: Record<string, IntegrationSpec> = {
  github: {
    docsUrl: 'https://docs.github.com/en/rest/commits/commits',
    apiHosts: ['api.github.com'],
    credentialKeys: ['installation_token'],
    buildAuthHeaders: (creds) => ({
      'api.github.com': [{
        transform: [{
          headers: {
            'Authorization': `token ${creds.installation_token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Verona-QA-Agent',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }],
      }],
    }),
  },

  posthog: {
    docsUrl: 'https://posthog.com/docs/api',
    apiHosts: ['us.posthog.com', 'eu.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com'],
    credentialKeys: ['api_key', 'project_id', 'api_host'],
    buildAuthHeaders: (creds) => {
      const hosts = ['us.posthog.com', 'eu.posthog.com', 'us.i.posthog.com', 'eu.i.posthog.com']
      const entry = [{
        transform: [{
          headers: { 'Authorization': `Bearer ${creds.api_key}` },
        }],
      }]
      return Object.fromEntries(hosts.map((h) => [h, entry]))
    },
  },

  sentry: {
    docsUrl: 'https://docs.sentry.io/api/',
    apiHosts: ['sentry.io'],
    credentialKeys: ['auth_token', 'organization_slug', 'project_slug'],
    buildAuthHeaders: (creds) => ({
      'sentry.io': [{
        transform: [{
          headers: { 'Authorization': `Bearer ${creds.auth_token}` },
        }],
      }],
    }),
  },

  langsmith: {
    docsUrl: 'https://docs.langchain.com/langsmith/reference',
    apiHosts: ['api.smith.langchain.com'],
    credentialKeys: ['api_key', 'project_name'],
    buildAuthHeaders: (creds) => ({
      'api.smith.langchain.com': [{
        transform: [{
          headers: { 'X-API-Key': creds.api_key },
        }],
      }],
    }),
  },

  braintrust: {
    docsUrl: 'https://www.braintrust.dev/docs/api-reference/introduction',
    apiHosts: ['api.braintrust.dev'],
    credentialKeys: ['api_key', 'project_name'],
    buildAuthHeaders: (creds) => ({
      'api.braintrust.dev': [{
        transform: [{
          headers: { 'Authorization': `Bearer ${creds.api_key}` },
        }],
      }],
    }),
  },
}
