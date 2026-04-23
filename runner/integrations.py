"""
Integration API clients for the Modal runner.
Fetches data from GitHub, PostHog, Sentry, LangSmith, and Braintrust.
"""
import os
import time
import base64
import jwt
import httpx
from datetime import datetime, timezone, timedelta
from runner.encryption import decrypt
from runner.logging import test_log


# ---------------------------------------------------------------------------
# GitHub
# ---------------------------------------------------------------------------

async def fetch_recent_commits(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent commits from the linked GitHub repository (one per project)."""
    installation_id = config.get("installation_id")
    repo_obj = config.get("repo")
    full_name = ""
    if isinstance(repo_obj, dict):
        full_name = str(repo_obj.get("full_name") or "")

    if not installation_id or not full_name:
        return []

    token = await get_github_installation_token(int(installation_id))
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()

    all_commits = []
    async with httpx.AsyncClient() as client:
        for repo in [full_name]:
            response = await client.get(
                f"https://api.github.com/repos/{repo}/commits",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github.v3+json",
                },
                params={"since": since, "per_page": 20},
            )
            if response.status_code == 200:
                for c in response.json():
                    all_commits.append({
                        "sha": c["sha"][:8],
                        "message": c["commit"]["message"][:200],
                        "date": c["commit"]["author"]["date"],
                        "author": c["commit"]["author"]["name"],
                        "repo": repo,
                    })
            else:
                test_log(
                    "warn",
                    "integrations_github_commits_non_200",
                    repo=repo,
                    status_code=response.status_code,
                    body_preview=response.text[:200],
                )
    return all_commits


async def get_github_installation_token(installation_id: int) -> str:
    """Generate a GitHub App installation access token via JWT."""
    app_id = os.environ.get("GITHUB_APP_ID")
    private_key_b64 = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
    if not app_id or not private_key_b64:
        raise ValueError("GitHub App credentials not configured")

    private_key = base64.b64decode(private_key_b64).decode("utf-8")
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": app_id}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"https://api.github.com/app/installations/{installation_id}/access_tokens",
            headers={
                "Authorization": f"Bearer {encoded_jwt}",
                "Accept": "application/vnd.github.v3+json",
            },
        )
        response.raise_for_status()
        return response.json()["token"]


# ---------------------------------------------------------------------------
# PostHog
# ---------------------------------------------------------------------------

async def fetch_posthog_sessions(config: dict, limit: int = 30) -> list[dict]:
    """Fetch recent session recordings from PostHog."""
    api_key_encrypted = config.get("api_key_encrypted")
    project_id = config.get("posthog_project_id")
    api_host = config.get("api_host", "https://us.posthog.com")
    if not api_key_encrypted or not project_id:
        return []

    api_key = decrypt(api_key_encrypted)
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{api_host}/api/projects/{project_id}/session_recordings/",
            headers={"Authorization": f"Bearer {api_key}"},
            params={"limit": limit},
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_posthog_sessions_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []
        return response.json().get("results", [])


async def fetch_posthog_errors(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent error events from PostHog using HogQL."""
    api_key_encrypted = config.get("api_key_encrypted")
    project_id = config.get("posthog_project_id")
    api_host = config.get("api_host", "https://us.posthog.com")
    if not api_key_encrypted or not project_id:
        return []

    api_key = decrypt(api_key_encrypted)
    date_from = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%Y-%m-%d")

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_host}/api/projects/{project_id}/query/",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "query": {
                    "kind": "HogQLQuery",
                    "query": (
                        f"SELECT properties.$current_url, properties.$exception_type, "
                        f"properties.$exception_message, count() as count "
                        f"FROM events "
                        f"WHERE event = '$exception' AND timestamp > '{date_from}' "
                        f"GROUP BY properties.$current_url, properties.$exception_type, "
                        f"properties.$exception_message "
                        f"ORDER BY count DESC LIMIT 30"
                    ),
                }
            },
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_posthog_errors_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []
        return response.json().get("results", [])


async def fetch_posthog_realtime_errors(config: dict, since_minutes: int = 5) -> list[dict]:
    """Fetch PostHog exception events within a recent time window."""
    api_key_encrypted = config.get("api_key_encrypted")
    project_id = config.get("posthog_project_id")
    api_host = config.get("api_host", "https://us.posthog.com")
    if not api_key_encrypted or not project_id:
        return []

    api_key = decrypt(api_key_encrypted)
    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_host}/api/projects/{project_id}/query/",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "query": {
                    "kind": "HogQLQuery",
                    "query": (
                        f"SELECT event, timestamp, distinct_id, "
                        f"properties.$current_url as url, "
                        f"properties.$exception_type as exception_type, "
                        f"properties.$exception_message as exception_message "
                        f"FROM events "
                        f"WHERE event = '$exception' AND timestamp > '{since}' "
                        f"ORDER BY timestamp DESC LIMIT 50"
                    ),
                }
            },
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_posthog_realtime_errors_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []

        rows = response.json().get("results", [])
        return [
            {
                "event": row[0] if len(row) > 0 else "$exception",
                "timestamp": row[1] if len(row) > 1 else "",
                "url": row[3] if len(row) > 3 else "",
                "exception_type": row[4] if len(row) > 4 else "",
                "exception_message": row[5] if len(row) > 5 else "",
            }
            for row in rows
        ]


# ---------------------------------------------------------------------------
# Sentry
# ---------------------------------------------------------------------------

SENTRY_API_BASE = "https://sentry.io/api/0"


async def fetch_sentry_issues(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent unresolved issues from Sentry."""
    auth_token_encrypted = config.get("auth_token_encrypted")
    org_slug = config.get("organization_slug")
    project_slug = config.get("project_slug")
    if not auth_token_encrypted or not org_slug or not project_slug:
        return []

    auth_token = decrypt(auth_token_encrypted)
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SENTRY_API_BASE}/projects/{org_slug}/{project_slug}/issues/",
            headers={"Authorization": f"Bearer {auth_token}"},
            params={
                "query": "is:unresolved",
                "sort": "date",
                "statsPeriod": f"{since_days * 24}h",
            },
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_sentry_issues_non_200",
                status_code=response.status_code,
                org_slug=org_slug,
                project_slug=project_slug,
                body_preview=response.text[:200],
            )
            return []

        return [
            {
                "id": str(issue.get("id", "")),
                "title": str(issue.get("title", "")),
                "culprit": str(issue.get("culprit", "")),
                "count": str(issue.get("count", "0")),
                "level": str(issue.get("level", "error")),
                "last_seen": str(issue.get("lastSeen", "")),
                "permalink": str(issue.get("permalink", "")),
            }
            for issue in response.json()[:50]
        ]


async def fetch_sentry_realtime_events(config: dict, since_minutes: int = 5) -> list[dict]:
    """Fetch Sentry events within a recent time window."""
    auth_token_encrypted = config.get("auth_token_encrypted")
    org_slug = config.get("organization_slug")
    project_slug = config.get("project_slug")
    if not auth_token_encrypted or not org_slug or not project_slug:
        return []

    auth_token = decrypt(auth_token_encrypted)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{SENTRY_API_BASE}/projects/{org_slug}/{project_slug}/events/",
            headers={"Authorization": f"Bearer {auth_token}"},
            params={"full": "true"},
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_sentry_events_non_200",
                status_code=response.status_code,
                org_slug=org_slug,
                project_slug=project_slug,
                body_preview=response.text[:200],
            )
            return []

        events = response.json()
        return [
            {
                "event_id": str(e.get("eventID", "")),
                "title": str(e.get("title", "")),
                "message": str(e.get("message", e.get("title", ""))),
                "level": str(e.get("level", "error")),
                "timestamp": str(e.get("dateCreated", "")),
            }
            for e in events
            if _parse_dt(str(e.get("dateCreated", ""))) >= cutoff
        ][:50]


# ---------------------------------------------------------------------------
# LangSmith
# ---------------------------------------------------------------------------

DEFAULT_LANGSMITH_URL = "https://api.smith.langchain.com"


async def fetch_langsmith_traces(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch recent LLM traces from LangSmith."""
    api_key_encrypted = config.get("api_key_encrypted")
    if not api_key_encrypted:
        return []

    api_key = decrypt(api_key_encrypted)
    api_url = config.get("api_url", DEFAULT_LANGSMITH_URL)
    project_name = config.get("project_name")
    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()

    body: dict = {
        "filter": f'gte(start_time, "{since}")',
        "limit": 50,
    }
    if project_name:
        body["session_name"] = project_name

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_url}/api/v1/runs/query",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_langsmith_traces_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []

        runs = response.json().get("runs", [])
        return [
            {
                "id": str(r.get("id", "")),
                "name": str(r.get("name", "")),
                "run_type": str(r.get("run_type", "")),
                "status": str(r.get("status", "")),
                "error": str(r.get("error", "")) if r.get("error") else None,
                "start_time": str(r.get("start_time", "")),
                "total_tokens": r.get("total_tokens"),
            }
            for r in runs
        ]


async def fetch_langsmith_errors(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch failed LLM runs from LangSmith."""
    api_key_encrypted = config.get("api_key_encrypted")
    if not api_key_encrypted:
        return []

    api_key = decrypt(api_key_encrypted)
    api_url = config.get("api_url", DEFAULT_LANGSMITH_URL)
    project_name = config.get("project_name")
    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()

    body: dict = {
        "filter": f'and(gte(start_time, "{since}"), eq(status, "error"))',
        "limit": 50,
    }
    if project_name:
        body["session_name"] = project_name

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_url}/api/v1/runs/query",
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_langsmith_errors_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []

        runs = response.json().get("runs", [])
        return [
            {
                "id": str(r.get("id", "")),
                "name": str(r.get("name", "")),
                "run_type": str(r.get("run_type", "")),
                "error": str(r.get("error", "")),
                "start_time": str(r.get("start_time", "")),
            }
            for r in runs
        ]


# ---------------------------------------------------------------------------
# Braintrust
# ---------------------------------------------------------------------------

DEFAULT_BRAINTRUST_URL = "https://api.braintrust.dev"


async def fetch_braintrust_logs(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch recent evaluation logs from Braintrust."""
    api_key_encrypted = config.get("api_key_encrypted")
    if not api_key_encrypted:
        return []

    api_key = decrypt(api_key_encrypted)
    api_url = config.get("api_url", DEFAULT_BRAINTRUST_URL)
    project_name = config.get("project_name")

    if not project_name:
        return []

    project_id = await _resolve_braintrust_project_id(api_key, api_url, project_name)
    if not project_id:
        return []

    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{api_url}/v1/project_logs/{project_id}/fetch",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "filters": [{"type": "path_lookup", "path": ["created"], "value": since}],
                "limit": 50,
            },
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_braintrust_logs_non_200",
                status_code=response.status_code,
                body_preview=response.text[:200],
            )
            return []

        events = response.json().get("events", [])
        return [
            {
                "id": str(e.get("id", "")),
                "output": e.get("output"),
                "scores": e.get("scores"),
                "error": str(e.get("error", "")) if e.get("error") else None,
                "created": str(e.get("created", "")),
            }
            for e in events
        ]


async def fetch_braintrust_errors(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch Braintrust log entries that have errors or low scores."""
    logs = await fetch_braintrust_logs(config, since_minutes)
    errors = []
    for log in logs:
        has_error = bool(log.get("error"))
        scores = log.get("scores") or {}
        has_low_score = any(
            isinstance(v, (int, float)) and v < 0.5
            for v in scores.values()
        )
        if has_error or has_low_score:
            errors.append(log)
    return errors


async def _resolve_braintrust_project_id(api_key: str, api_url: str, project_name: str) -> str | None:
    """Look up a Braintrust project ID by name."""
    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"{api_url}/v1/project",
            headers={"Authorization": f"Bearer {api_key}"},
            params={"project_name": project_name, "limit": 1},
        )
        if response.status_code != 200:
            test_log(
                "warn",
                "integrations_braintrust_project_lookup_non_200",
                status_code=response.status_code,
                project_name=project_name,
                body_preview=response.text[:200],
            )
            return None

        objects = response.json().get("objects", [])
        if not objects:
            return None
        return str(objects[0].get("id", ""))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_dt(s: str) -> datetime:
    """Best-effort ISO datetime parse."""
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return datetime.min.replace(tzinfo=timezone.utc)
