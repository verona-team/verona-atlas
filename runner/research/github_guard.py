"""Port of `lib/github-integration-guard.ts::getGithubIntegrationReady`.

Returns a structured ok/reason result so callers can short-circuit with a
user-facing error message when GitHub isn't fully configured for a project.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from supabase import Client


@dataclass
class GithubReadyOk:
    installation_id: int
    repo_full_name: str


@dataclass
class GithubReadyErr:
    reason: str


GithubReadyState = GithubReadyOk | GithubReadyErr


def get_github_integration_ready(sb: Client, project_id: str) -> GithubReadyState:
    resp = (
        sb.table("integrations")
        .select("config, status")
        .eq("project_id", project_id)
        .eq("type", "github")
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return GithubReadyErr(
            reason=(
                "GitHub is not connected. Connect GitHub and select a repository "
                "in project setup."
            )
        )

    config: dict[str, Any] = rows[0].get("config") or {}
    installation_id = config.get("installation_id")
    if not installation_id:
        return GithubReadyErr(
            reason="GitHub installation is incomplete. Reconnect GitHub from project setup."
        )

    repo = config.get("repo") or {}
    full_name = None
    if isinstance(repo, dict):
        candidate = repo.get("full_name")
        if isinstance(candidate, str) and candidate:
            full_name = candidate

    if not full_name:
        return GithubReadyErr(
            reason="Select a GitHub repository for this project in setup or settings."
        )

    return GithubReadyOk(installation_id=int(installation_id), repo_full_name=full_name)
