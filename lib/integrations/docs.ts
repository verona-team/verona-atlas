const docsCache = new Map<string, { content: string; fetchedAt: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000

const DOCS_URLS: Record<string, string[]> = {
  github: [
    'https://docs.github.com/en/rest/commits/commits.md',
    'https://docs.github.com/en/rest/repos/repos.md',
    'https://docs.github.com/en/rest/pulls/pulls.md',
    'https://docs.github.com/en/rest/issues/issues.md',
  ],
  posthog: [
    'https://posthog.com/docs/api/query.md',
    'https://posthog.com/docs/api/events.md',
    'https://posthog.com/docs/api/session-recordings.md',
  ],
  sentry: [
    'https://docs.sentry.io/api/events/list-a-projects-issues/',
    'https://docs.sentry.io/api/events/list-a-projects-error-events/',
  ],
  langsmith: [
    'https://docs.langchain.com/langsmith/trace-with-api',
    'https://docs.langchain.com/langsmith/reference',
  ],
  braintrust: [
    'https://www.braintrust.dev/docs/api-reference/introduction',
  ],
}

const FALLBACK_DOCS: Record<string, string> = {
  github: `# GitHub REST API
Base URL: https://api.github.com
Auth header is automatically injected.

Key endpoints:
- GET /repos/{owner}/{repo}/commits — list recent commits. Supports ?since=ISO_DATE&per_page=30
- GET /repos/{owner}/{repo}/pulls — list pull requests. Supports ?state=open|closed|all&sort=updated
- GET /repos/{owner}/{repo}/issues — list issues. Supports ?state=open&sort=updated&since=ISO_DATE
- GET /repos/{owner}/{repo} — get repo metadata
- GET /installation/repositories — list all repos accessible to the installation

Response format is JSON. Commits have .sha, .commit.message, .commit.author.name, .commit.author.date fields.
Pull requests have .title, .body, .changed_files, .additions, .deletions, .merged_at, .user.login fields.`,

  posthog: `# PostHog API
Auth header is automatically injected.
The API host and project ID are provided as environment variables POSTHOG_HOST and POSTHOG_PROJECT_ID.

Key endpoints:
- GET {host}/api/projects/{project_id}/session_recordings/?limit=50 — list recent session recordings
- POST {host}/api/projects/{project_id}/query/ — run HogQL queries

Example HogQL for error events:
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT properties.$current_url, properties.$exception_type, properties.$exception_message, count() as count FROM events WHERE event = '$exception' AND timestamp > '2025-01-01' GROUP BY properties.$current_url, properties.$exception_type, properties.$exception_message ORDER BY count DESC LIMIT 50"
  }
}

Example HogQL for top pages:
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT properties.$current_url as url, count() as pageviews, count(distinct distinct_id) as unique_users FROM events WHERE event = '$pageview' AND timestamp > '2025-01-01' GROUP BY url ORDER BY pageviews DESC LIMIT 30"
  }
}`,

  sentry: `# Sentry API
Base URL: https://sentry.io/api/0
Auth header is automatically injected.
The organization slug and project slug are provided as environment variables SENTRY_ORG_SLUG and SENTRY_PROJECT_SLUG.

Key endpoints:
- GET /api/0/projects/{org_slug}/{project_slug}/issues/?query=is:unresolved&sort=date — list unresolved issues. Returns array of objects with .id, .title, .culprit, .count, .firstSeen, .lastSeen, .level, .status, .permalink
- GET /api/0/projects/{org_slug}/{project_slug}/events/?full=true — list recent error events. Returns objects with .eventID, .title, .message, .level, .dateCreated, .tags
- GET /api/0/issues/{issue_id}/events/?limit=10 — list events for a specific issue`,

  langsmith: `# LangSmith API
Base URL: https://api.smith.langchain.com
Auth header is automatically injected via X-API-Key.
The project name is provided as environment variable LANGSMITH_PROJECT_NAME (optional).

Key endpoints:
- GET /api/v1/sessions?limit=100 — list projects (called "sessions" in the API)
- POST /api/v1/runs/query — query runs. Body: { "filter": "gte(start_time, \\"ISO_DATE\\")", "limit": 50 } or { "filter": "and(gte(start_time, \\"ISO_DATE\\"), eq(status, \\"error\\"))", "limit": 50 } for failed runs only. Optionally add "session_name": "project-name" to filter by project.
- Response .runs[] has .id, .name, .run_type, .status, .error, .start_time, .end_time, .total_tokens, .prompt_tokens, .completion_tokens`,

  braintrust: `# Braintrust API
Base URL: https://api.braintrust.dev
Auth header is automatically injected.
The project name is provided as environment variable BRAINTRUST_PROJECT_NAME (optional).

Key endpoints:
- GET /v1/project?limit=100 — list projects. Response .objects[] has .id, .name
- GET /v1/experiment?project_id={id}&limit=10 — list experiments for a project. Response .objects[] has .id, .name, .project_id, .created
- POST /v1/project_logs/{project_id}/fetch — fetch recent logs. Body: { "filters": [{"type": "path_lookup", "path": ["created"], "value": "ISO_DATE"}], "limit": 50 }. Response .events[] has .id, .input, .output, .expected, .scores, .error, .metadata, .created`,
}

async function fetchUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'text/markdown, text/plain, */*' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    const text = await response.text()
    return text.slice(0, 15000)
  } catch {
    return null
  }
}

export async function fetchIntegrationDocs(type: string): Promise<string> {
  const cached = docsCache.get(type)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.content
  }

  const urls = DOCS_URLS[type]
  if (urls) {
    const results = await Promise.allSettled(urls.map(fetchUrl))
    const fetched = results
      .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled' && !!r.value)
      .map((r) => r.value!)

    if (fetched.length > 0) {
      const content = fetched.join('\n\n---\n\n').slice(0, 30000)
      docsCache.set(type, { content, fetchedAt: Date.now() })
      return content
    }
  }

  const fallback = FALLBACK_DOCS[type] ?? `No documentation available for ${type}.`
  docsCache.set(type, { content: fallback, fetchedAt: Date.now() })
  return fallback
}
