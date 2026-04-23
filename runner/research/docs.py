"""Static integration API docs passed to the research agent as context.

Lifted verbatim from `lib/integrations/docs.ts::FALLBACK_DOCS`. The TS
version also tried to fetch fresh docs from each provider's documentation
site with a 1h cache; the Python port skips the network fetch because:

1. The static text has been sufficient for the agent in practice.
2. Modal workers are per-invocation — no persistent cache to benefit from.
3. The one external network hop we avoid is pure latency win.

If we ever need fresher docs, add a background Modal function that updates
a Supabase row on a schedule and read from there.
"""
from __future__ import annotations


_DOCS: dict[str, str] = {
    "github": """# GitHub REST API
Base URL: https://api.github.com
Auth header is automatically injected.

Key endpoints:
- GET /repos/{owner}/{repo}/commits — list recent commits. Supports ?since=ISO_DATE&per_page=30
- GET /repos/{owner}/{repo}/pulls — list pull requests. Supports ?state=open|closed|all&sort=updated
- GET /repos/{owner}/{repo}/issues — list issues. Supports ?state=open&sort=updated&since=ISO_DATE
- GET /repos/{owner}/{repo} — get repo metadata
- GET /installation/repositories — list all repos accessible to the installation

Response format is JSON. Commits have .sha, .commit.message, .commit.author.name, .commit.author.date fields.
Pull requests have .title, .body, .changed_files, .additions, .deletions, .merged_at, .user.login fields.""",

    "posthog": """# PostHog API
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
}""",

    "sentry": """# Sentry API
Base URL: https://sentry.io/api/0
Auth header is automatically injected.
The organization slug and project slug are provided as environment variables SENTRY_ORG_SLUG and SENTRY_PROJECT_SLUG.

Key endpoints:
- GET /api/0/projects/{org_slug}/{project_slug}/issues/?query=is:unresolved&sort=date — list unresolved issues.
- GET /api/0/projects/{org_slug}/{project_slug}/events/?full=true — list recent error events.
- GET /api/0/issues/{issue_id}/events/?limit=10 — list events for a specific issue""",

    "langsmith": """# LangSmith API
Base URL: https://api.smith.langchain.com
Auth header is automatically injected via X-API-Key.
The project name is provided as environment variable LANGSMITH_PROJECT_NAME (optional).

Key endpoints:

1. GET /api/v1/sessions?limit=100 — list all projects (called "sessions" in the API).
2. POST /api/v1/runs/query — query runs. IMPORTANT: You MUST provide a "session" field with an array of session UUIDs.
3. GET /api/v1/sessions/<session-id> — get details for a single project/session

Workflow: First list sessions (step 1), then use the session IDs to query runs (step 2).""",

    "braintrust": """# Braintrust API
Base URL: https://api.braintrust.dev
Auth header is automatically injected.

Key endpoints:
- GET /v1/project?limit=100 — list projects. Response .objects[] has .id, .name
- GET /v1/experiment?project_id={id}&limit=10 — list experiments.
- POST /v1/project_logs/{project_id}/fetch — fetch recent logs.""",
}


def get_integration_docs(integration_type: str) -> str:
    """Return static docs for an integration type, or a 'no docs' stub."""
    return _DOCS.get(
        integration_type,
        f"No documentation available for {integration_type}.",
    )


def get_integration_docs_bundle(types: list[str]) -> dict[str, str]:
    """Return `{type -> docs}` for the given types, in order."""
    return {t: get_integration_docs(t) for t in types}
