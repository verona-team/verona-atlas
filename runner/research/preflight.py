"""Per-integration preflight data collection.

Each function here hits an integration's API with a fixed shape and returns
a compact summary dict. The integration research agent feeds these into the
LLM as "here's what's already known — go deeper if you need to" context,
mirroring the TS `PREFLIGHT_SCRIPTS`.

Structured as individual async functions (one per integration) so the agent
can still selectively skip integrations and so each can be traced in
LangSmith independently if desired.

All preflights have the same error contract: on any failure return
`{"error": "...", "success": False}` rather than raising, so the agent
loop can see partial data even when one integration errors.
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from runner.encryption import decrypt


# How many of the most recently merged PRs we drill into for per-file churn.
# 5 is enough to identify the genuinely hot files without ballooning the
# preflight time budget; each drill-in is one extra GitHub call.
_GH_CHURN_PR_DEPTH = 5

# Cap on the size of `topChangedPaths` in the preflight result.
_GH_TOP_CHANGED_LIMIT = 20

# File patterns we never include in `topChangedPaths` — they're never the
# right "read me first" target for the codebase agent.
_GH_CHURN_EXCLUDE_RE = re.compile(
    r"(?:"
    r"\.test\.[^/]+$|"
    r"\.spec\.[^/]+$|"
    r"\.snap$|"
    r"(?:^|/)__tests?__/|"
    r"(?:^|/)tests?/|"
    r"\.lock$|"
    r"^pnpm-lock\.yaml$|"
    r"^package-lock\.json$|"
    r"^yarn\.lock$|"
    r"^poetry\.lock$|"
    r"^Cargo\.lock$|"
    r"^go\.sum$"
    r")",
    re.IGNORECASE,
)


def _is_churn_excluded(path: str) -> bool:
    """Return True if `path` matches a pattern we never seed the codebase agent with."""
    return bool(_GH_CHURN_EXCLUDE_RE.search(path))


async def preflight_github(
    *,
    installation_token: str,
    owner: str,
    repo: str,
) -> dict[str, Any]:
    """Fetch recent commits + open/merged PRs for the repo (last 7 days)."""
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    headers = {
        "Authorization": f"token {installation_token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Verona-QA-Agent",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            commits_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/commits",
                headers=headers,
                params={"since": since, "per_page": 100},
            )
            open_prs_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls",
                headers=headers,
                params={"state": "open", "sort": "updated", "per_page": 30},
            )
            closed_prs_resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls",
                headers=headers,
                params={"state": "closed", "sort": "updated", "per_page": 30},
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"GitHub preflight HTTP error: {e}"}

    if commits_resp.status_code != 200:
        return {
            "success": False,
            "error": f"GitHub commits API returned {commits_resp.status_code}",
        }

    commits_raw = commits_resp.json()
    open_prs_raw = open_prs_resp.json() if open_prs_resp.status_code == 200 else []
    closed_prs_raw = (
        closed_prs_resp.json() if closed_prs_resp.status_code == 200 else []
    )

    merged_prs = [p for p in closed_prs_raw if p.get("merged_at")]

    # Drill in on the N most recently merged PRs to compute per-file churn.
    # Each call hits `/pulls/{n}/files`; we run them in parallel.
    top_changed_paths = await _aggregate_top_changed_paths(
        owner=owner,
        repo=repo,
        merged_prs=merged_prs,
        headers=headers,
    )

    return {
        "success": True,
        "commits": {
            "total": len(commits_raw),
            "items": [
                {
                    "sha": (c.get("sha") or "")[:8],
                    "message": ((c.get("commit") or {}).get("message") or "")
                    .split("\n")[0][:120],
                    "author": ((c.get("commit") or {}).get("author") or {}).get("name"),
                    "date": ((c.get("commit") or {}).get("author") or {}).get("date"),
                    "login": (c.get("author") or {}).get("login"),
                }
                for c in commits_raw[:50]
            ],
        },
        "openPrs": [
            {
                "number": p.get("number"),
                "title": (p.get("title") or "")[:100],
                "author": (p.get("user") or {}).get("login"),
                "created_at": p.get("created_at"),
                "draft": p.get("draft"),
            }
            for p in open_prs_raw
        ],
        "mergedPrs": [
            {
                "number": p.get("number"),
                "title": (p.get("title") or "")[:100],
                "author": (p.get("user") or {}).get("login"),
                "merged_at": p.get("merged_at"),
                "head_branch": (p.get("head") or {}).get("ref"),
            }
            for p in merged_prs
        ],
        "topChangedPaths": top_changed_paths,
    }


async def _aggregate_top_changed_paths(
    *,
    owner: str,
    repo: str,
    merged_prs: list[dict[str, Any]],
    headers: dict[str, str],
) -> list[dict[str, Any]]:
    """Return the top-N file paths by recent churn across the most-recent merged PRs.

    For up to `_GH_CHURN_PR_DEPTH` of the most-recently-merged PRs (already
    sorted desc by `updated`), fetches `/pulls/{n}/files` in parallel and
    aggregates per-file additions+deletions plus the set of PR numbers that
    touched each file.

    Test files, lock files, and snapshots are dropped — they're never the
    "read me first" target for the codebase agent. Returns at most
    `_GH_TOP_CHANGED_LIMIT` entries, sorted by total churn descending.

    Best-effort: any individual PR-files fetch failure is logged via the
    return value being missing for that PR; the aggregate continues with
    whatever succeeded. Returns an empty list rather than raising.
    """
    if not merged_prs:
        return []

    target_prs = merged_prs[:_GH_CHURN_PR_DEPTH]

    async def _fetch_pr_files(client: httpx.AsyncClient, pr_number: int) -> list[dict[str, Any]]:
        try:
            resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/files",
                headers=headers,
                params={"per_page": 100},
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            return data if isinstance(data, list) else []
        except httpx.HTTPError:
            return []

    filtered_prs = [p for p in target_prs if p.get("number") is not None]

    async with httpx.AsyncClient(timeout=60) as client:
        results = await asyncio.gather(
            *(_fetch_pr_files(client, int(p.get("number"))) for p in filtered_prs),
            return_exceptions=False,
        )

    # path -> {"additions": int, "deletions": int, "prs": set[int]}
    agg: dict[str, dict[str, Any]] = {}
    for pr, files in zip(filtered_prs, results):
        pr_number = pr.get("number")
        for f in files or []:
            filename = f.get("filename")
            if not isinstance(filename, str) or not filename:
                continue
            if _is_churn_excluded(filename):
                continue
            entry = agg.setdefault(
                filename,
                {"additions": 0, "deletions": 0, "prs": set()},
            )
            entry["additions"] += int(f.get("additions") or 0)
            entry["deletions"] += int(f.get("deletions") or 0)
            if isinstance(pr_number, int):
                entry["prs"].add(pr_number)

    sorted_paths = sorted(
        agg.items(),
        key=lambda kv: (kv[1]["additions"] + kv[1]["deletions"]),
        reverse=True,
    )

    return [
        {
            "path": path,
            "additions": data["additions"],
            "deletions": data["deletions"],
            "prCount": len(data["prs"]),
            "prNumbers": sorted(data["prs"]),
        }
        for path, data in sorted_paths[:_GH_TOP_CHANGED_LIMIT]
    ]


async def preflight_posthog(
    *,
    api_key: str,
    api_host: str,
    project_id: str,
) -> dict[str, Any]:
    """Pull top rage-click URLs + recent exception events + top pageviews."""
    host = api_host.rstrip("/")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            rage_resp = await client.post(
                f"{host}/api/projects/{project_id}/query/",
                headers=headers,
                json={
                    "query": {
                        "kind": "HogQLQuery",
                        "query": (
                            "SELECT properties.$current_url as url, "
                            "count() as rage_clicks "
                            "FROM events "
                            "WHERE event = '$rageclick' "
                            "AND timestamp > now() - interval 14 day "
                            "GROUP BY url ORDER BY rage_clicks DESC LIMIT 20"
                        ),
                    }
                },
            )
            errors_resp = await client.post(
                f"{host}/api/projects/{project_id}/query/",
                headers=headers,
                json={
                    "query": {
                        "kind": "HogQLQuery",
                        "query": (
                            "SELECT properties.$current_url as url, "
                            "properties.$exception_type as type, "
                            "properties.$exception_message as message, "
                            "count() as c "
                            "FROM events "
                            "WHERE event = '$exception' "
                            "AND timestamp > now() - interval 14 day "
                            "GROUP BY url, type, message ORDER BY c DESC LIMIT 30"
                        ),
                    }
                },
            )
            pages_resp = await client.post(
                f"{host}/api/projects/{project_id}/query/",
                headers=headers,
                json={
                    "query": {
                        "kind": "HogQLQuery",
                        "query": (
                            "SELECT properties.$current_url as url, count() as views "
                            "FROM events "
                            "WHERE event = '$pageview' "
                            "AND timestamp > now() - interval 14 day "
                            "GROUP BY url ORDER BY views DESC LIMIT 20"
                        ),
                    }
                },
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"PostHog preflight HTTP error: {e}"}

    def _rows(resp: httpx.Response) -> list[list[Any]]:
        if resp.status_code != 200:
            return []
        try:
            return list(resp.json().get("results", []))
        except Exception:
            return []

    return {
        "success": True,
        "rageClicks": [
            {"url": r[0] if len(r) > 0 else "", "rage_clicks": r[1] if len(r) > 1 else 0}
            for r in _rows(rage_resp)
        ],
        "exceptions": [
            {
                "url": r[0] if len(r) > 0 else "",
                "type": r[1] if len(r) > 1 else "",
                "message": (r[2] if len(r) > 2 else "") or "",
                "count": r[3] if len(r) > 3 else 0,
            }
            for r in _rows(errors_resp)
        ],
        "topPages": [
            {"url": r[0] if len(r) > 0 else "", "views": r[1] if len(r) > 1 else 0}
            for r in _rows(pages_resp)
        ],
    }


async def preflight_sentry(
    *,
    auth_token: str,
    org_slug: str,
    project_slug: str,
) -> dict[str, Any]:
    """Top unresolved issues + recent events."""
    headers = {"Authorization": f"Bearer {auth_token}"}
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            issues_resp = await client.get(
                f"https://sentry.io/api/0/projects/{org_slug}/{project_slug}/issues/",
                headers=headers,
                params={"query": "is:unresolved", "sort": "freq", "limit": 30},
            )
            events_resp = await client.get(
                f"https://sentry.io/api/0/projects/{org_slug}/{project_slug}/events/",
                headers=headers,
                params={"full": "true", "limit": 30},
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"Sentry preflight HTTP error: {e}"}

    if issues_resp.status_code != 200:
        return {
            "success": False,
            "error": f"Sentry issues API returned {issues_resp.status_code}",
        }

    issues = issues_resp.json()
    events = events_resp.json() if events_resp.status_code == 200 else []

    return {
        "success": True,
        "unresolvedIssues": [
            {
                "id": str(i.get("id", "")),
                "title": str(i.get("title", "")),
                "culprit": str(i.get("culprit", "")),
                "count": str(i.get("count", "0")),
                "firstSeen": str(i.get("firstSeen", "")),
                "lastSeen": str(i.get("lastSeen", "")),
                "level": str(i.get("level", "error")),
            }
            for i in issues
        ],
        "recentEvents": [
            {
                "id": str(e.get("eventID", "")),
                "title": str(e.get("title", "")),
                "message": (str(e.get("message", "") or e.get("title", "")))[:200],
                "level": str(e.get("level", "error")),
                "dateCreated": str(e.get("dateCreated", "")),
            }
            for e in events
        ],
    }


async def preflight_langsmith(
    *,
    api_key: str,
    project_name: str | None,
) -> dict[str, Any]:
    """Recent failed runs for the configured project."""
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            sessions_resp = await client.get(
                "https://api.smith.langchain.com/api/v1/sessions",
                headers=headers,
                params={"limit": 100},
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"LangSmith preflight HTTP error: {e}"}

    if sessions_resp.status_code != 200:
        return {
            "success": False,
            "error": f"LangSmith sessions API returned {sessions_resp.status_code}",
        }

    sessions = sessions_resp.json() or []
    target_session_id: str | None = None
    if project_name:
        for s in sessions:
            if s.get("name") == project_name:
                target_session_id = s.get("id")
                break
    if target_session_id is None and sessions:
        target_session_id = sessions[0].get("id")

    if target_session_id is None:
        return {"success": True, "sessions": [], "errorRuns": []}

    body = {
        "session": [target_session_id],
        "filter": f'and(gte(start_time, "{since}"), eq(status, "error"))',
        "limit": 30,
        "select": [
            "name",
            "run_type",
            "status",
            "error",
            "start_time",
            "end_time",
            "total_tokens",
        ],
    }
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            runs_resp = await client.post(
                "https://api.smith.langchain.com/api/v1/runs/query",
                headers=headers,
                json=body,
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"LangSmith runs query HTTP error: {e}"}

    if runs_resp.status_code != 200:
        return {
            "success": True,
            "sessions": sessions[:10],
            "errorRuns": [],
            "note": f"runs query returned {runs_resp.status_code}",
        }

    runs = runs_resp.json().get("runs", [])
    return {
        "success": True,
        "sessionUsed": target_session_id,
        "errorRuns": [
            {
                "name": r.get("name"),
                "run_type": r.get("run_type"),
                "error": (r.get("error") or "")[:200],
                "start_time": r.get("start_time"),
            }
            for r in runs
        ],
    }


async def preflight_braintrust(*, api_key: str) -> dict[str, Any]:
    """List projects + recent experiments for the first few projects."""
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            projects_resp = await client.get(
                "https://api.braintrust.dev/v1/project?limit=100", headers=headers
            )
        except httpx.HTTPError as e:
            return {"success": False, "error": f"Braintrust preflight HTTP error: {e}"}

        if projects_resp.status_code != 200:
            return {
                "success": False,
                "error": f"Braintrust projects API returned {projects_resp.status_code}",
            }

        projects = (projects_resp.json() or {}).get("objects") or []
        out_projects = [{"id": p.get("id"), "name": p.get("name")} for p in projects]

        for p in out_projects[:5]:
            try:
                exp_resp = await client.get(
                    f"https://api.braintrust.dev/v1/experiment?project_id={p['id']}&limit=10",
                    headers=headers,
                )
                if exp_resp.status_code == 200:
                    experiments = (exp_resp.json() or {}).get("objects") or []
                    p["experiments"] = [
                        {
                            "id": e.get("id"),
                            "name": e.get("name"),
                            "created": e.get("created"),
                        }
                        for e in experiments
                    ]
                else:
                    p["experiments"] = []
            except httpx.HTTPError:
                p["experiments"] = []

    return {"success": True, "projects": out_projects}
