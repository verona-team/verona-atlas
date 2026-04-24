"""Top-level research entry point.

Composes `integration_agent` and `codebase_agent` in parallel, then merges
their outputs into a `ResearchReport`. Mirrors
`lib/research-agent/index.ts::runResearchAgent`.

The chat turn's `ensure_research` node calls this; nightly jobs also call
it with `force_refresh=True`.
"""
from __future__ import annotations

import asyncio
from typing import Any

from supabase import Client

from runner.chat.logging import chat_log
from runner.research.codebase_agent import run_codebase_exploration_agent
from runner.research.github_guard import (
    GithubReadyErr,
    GithubReadyOk,
    get_github_integration_ready,
)
from runner.research.integration_agent import run_integration_research
from runner.research.merge import merge_integration_and_codebase
from runner.research.types import (
    CodebaseExplorationResult,
    IntegrationResearchReport,
    ResearchReport,
    empty_codebase_exploration,
)


async def run_research_agent(
    sb: Client,
    *,
    project_id: str,
    app_url: str,
) -> ResearchReport:
    """Run both research tracks in parallel and merge.

    Always tries to run. On individual track failure, returns a low-confidence
    report rather than propagating the exception, so the chat turn can still
    produce some output for the user.
    """
    gh_state = get_github_integration_ready(sb, project_id)

    if isinstance(gh_state, GithubReadyErr):
        chat_log(
            "warn",
            "research_github_not_ready",
            project_id=project_id,
            reason=gh_state.reason,
        )
        # Without GitHub we still want to attempt integrations; we just can't
        # do a codebase track.
        integration_report = await _safe_integration_research(sb, project_id, app_url)
        return ResearchReport(
            summary=gh_state.reason,
            findings=integration_report.findings,
            recommendedFlows=integration_report.recommendedFlows
            + [
                f"Smoke test — load {app_url} and verify primary UI",
                "Complete GitHub setup to unlock repository-aware test planning",
            ],
            integrationsCovered=integration_report.integrationsCovered,
            integrationsSkipped=integration_report.integrationsSkipped + ["github"],
            drillInHighlights=list(integration_report.drillInHighlights),
            codebaseExploration=empty_codebase_exploration(
                summary=gh_state.reason,
                truncation_warnings=["GitHub integration incomplete"],
            ),
        )

    assert isinstance(gh_state, GithubReadyOk)

    integration_task = asyncio.create_task(
        _safe_integration_research(sb, project_id, app_url)
    )
    codebase_task = asyncio.create_task(
        _safe_codebase_research(
            installation_id=gh_state.installation_id,
            repo_full_name=gh_state.repo_full_name,
        )
    )

    integration_report, codebase_report = await asyncio.gather(
        integration_task, codebase_task
    )

    merged = merge_integration_and_codebase(integration_report, codebase_report)
    chat_log(
        "info",
        "research_agent_ok",
        project_id=project_id,
        integrations_covered=merged.integrationsCovered,
        integrations_skipped=merged.integrationsSkipped,
        findings_count=len(merged.findings),
        recommended_flow_count=len(merged.recommendedFlows),
        codebase_confidence=merged.codebaseExploration.confidence,
    )
    return merged


async def _safe_integration_research(
    sb: Client, project_id: str, app_url: str
) -> IntegrationResearchReport:
    try:
        resp = (
            sb.table("integrations")
            .select("*")
            .eq("project_id", project_id)
            .eq("status", "active")
            .execute()
        )
        rows: list[dict[str, Any]] = resp.data or []
        return await run_integration_research(
            app_url=app_url, active_integrations=rows
        )
    except Exception as e:
        chat_log(
            "error",
            "research_integration_track_failed",
            project_id=project_id,
            err=repr(e),
        )
        return IntegrationResearchReport(
            summary=(
                f"Integration research failed: {type(e).__name__}: {e}. "
                "Recommendations are based on general best practices."
            ),
            findings=[],
            recommendedFlows=["Homepage smoke test", "Primary navigation flow"],
            integrationsCovered=[],
            integrationsSkipped=[],
            drillInHighlights=[],
        )


async def _safe_codebase_research(
    *, installation_id: int, repo_full_name: str
) -> CodebaseExplorationResult:
    try:
        return await run_codebase_exploration_agent(
            installation_id=installation_id, repo_full_name=repo_full_name
        )
    except Exception as e:
        chat_log(
            "error",
            "research_codebase_track_failed",
            repo=repo_full_name,
            err=repr(e),
        )
        return empty_codebase_exploration(
            summary=(
                f"Repository exploration failed: {type(e).__name__}: {e}"
            ),
            truncation_warnings=[str(e)],
        )
