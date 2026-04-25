"""Top-level research entry point.

Composes `integration_agent` and `codebase_agent` in parallel, then
runs the two synthesis-stage LLM calls (also in parallel) and stitches
their outputs into a `ResearchReport`.

The chat turn's `ensure_research` node calls this; nightly jobs also
call it with `force_refresh=True`.

## Post-revamp control flow

1. **GitHub readiness check.** Short-circuits with a degraded
   `ResearchReport` if GitHub isn't configured — the codebase track
   needs a repo, so we don't even try to collect a transcript.

2. **Two ReAct transcripts, in parallel.**
   - `run_codebase_exploration_transcript(...)` → `CodebaseTranscript`
   - `run_integration_research_transcript(...)` → `IntegrationTranscript`

3. **Two synthesis calls, in parallel.** Both take the transcripts
   and run concurrently (neither depends on the other):
   - `generate_codebase_exploration(cb)` → `CodebaseExplorationResult`
   - `generate_flow_report(cb, intg, app_url)` → `FlowSynthOutput`

4. **Deterministic stitch.** Pure Python — no LLM — zips the two
   structured outputs + preflight metadata into the final
   `ResearchReport`.

Each of the four awaitables has its own `_safe_*` wrapping so a single
failure degrades gracefully rather than taking down the whole report.
"""
from __future__ import annotations

import asyncio
from typing import Any

from supabase import Client

from runner.chat.logging import chat_log
from runner.research.codebase_agent import run_codebase_exploration_transcript
from runner.research.github_guard import (
    GithubReadyErr,
    GithubReadyOk,
    get_github_integration_ready,
)
from runner.research.integration_agent import run_integration_research_transcript
from runner.research.synthesizer import (
    flatten_flows,
    flow_output_to_findings,
    generate_codebase_exploration,
    generate_flow_report,
)
from runner.research.types import (
    CodebaseExplorationResult,
    CodebaseTranscript,
    FlowSynthOutput,
    IntegrationTranscript,
    ResearchReport,
    TranscriptEntry,
    empty_codebase_exploration,
)


# ---------------------------------------------------------------------------
# Dedup helper
# ---------------------------------------------------------------------------


def _dedupe_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in items:
        t = s.strip() if isinstance(s, str) else ""
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


# ---------------------------------------------------------------------------
# Per-track "safe" wrappers
# ---------------------------------------------------------------------------


async def _safe_codebase_transcript(
    *, installation_id: int, repo_full_name: str
) -> CodebaseTranscript:
    """Run the codebase ReAct loop; on any exception return a minimal stub."""
    try:
        return await run_codebase_exploration_transcript(
            installation_id=installation_id, repo_full_name=repo_full_name
        )
    except Exception as e:
        chat_log(
            "error",
            "research_codebase_track_failed",
            repo=repo_full_name,
            err=repr(e),
        )
        return CodebaseTranscript(
            repo_full_name=repo_full_name,
            default_branch=None,
            path_count=0,
            tree_truncated=False,
            tree_warnings=[f"Codebase track failed: {type(e).__name__}: {e}"],
            orientation=(
                f"Codebase track failed: {type(e).__name__}: {e}. "
                "No repo exploration was performed."
            ),
            entries=[],
            step_budget_exhausted=False,
        )


async def _safe_integration_transcript(
    sb: Client, project_id: str, app_url: str
) -> IntegrationTranscript:
    """Run the integration ReAct loop; on any exception return a minimal stub."""
    try:
        resp = (
            sb.table("integrations")
            .select("*")
            .eq("project_id", project_id)
            .eq("status", "active")
            .execute()
        )
        rows: list[dict[str, Any]] = resp.data or []
        return await run_integration_research_transcript(
            app_url=app_url, active_integrations=rows
        )
    except Exception as e:
        chat_log(
            "error",
            "research_integration_track_failed",
            project_id=project_id,
            err=repr(e),
        )
        return IntegrationTranscript(
            app_url=app_url,
            integrations_covered=[],
            integrations_skipped=[],
            preflight_results={},
            orientation=(
                f"Integration track failed: {type(e).__name__}: {e}. "
                "No drill-in evidence was gathered."
            ),
            entries=[],
            step_budget_exhausted=False,
            sandbox_available=False,
        )


async def _safe_generate_codebase_exploration(
    cb: CodebaseTranscript,
) -> CodebaseExplorationResult:
    """Run the codebase-exploration synthesis call.

    The synthesizer itself already has graceful-failure internals (it
    returns an `empty_codebase_exploration(...)` on error). This wrapper
    exists so an uncaught exception here doesn't take down the whole
    orchestrator.
    """
    try:
        return await generate_codebase_exploration(cb)
    except Exception as e:
        chat_log(
            "error",
            "research_codebase_synthesis_uncaught",
            repo=cb.repo_full_name,
            err=repr(e),
        )
        return empty_codebase_exploration(
            summary=cb.orientation
            or "Codebase exploration synthesis failed uncaught.",
            truncation_warnings=[f"Synthesis uncaught: {type(e).__name__}: {e}"],
            tool_steps_used=cb.tool_steps_used,
        )


async def _safe_generate_flow_report(
    cb: CodebaseTranscript, intg: IntegrationTranscript, *, app_url: str
) -> FlowSynthOutput:
    """Run the flow-synthesis call with an outer guard."""
    try:
        return await generate_flow_report(cb, intg, app_url=app_url)
    except Exception as e:
        chat_log(
            "error",
            "research_flow_synthesis_uncaught",
            app_url=app_url,
            err=repr(e),
        )
        # Reuse the synthesizer's fallback shape; returning via its
        # private helper would be awkward across module boundaries, so
        # we just reproduce the minimal shape here.
        from runner.research.synthesizer import _flow_fallback  # type: ignore[attr-defined]

        return _flow_fallback(cb, intg, app_url, reason=f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


async def run_research_agent(
    sb: Client,
    *,
    project_id: str,
    app_url: str,
) -> ResearchReport:
    """Run both research tracks + both synthesis calls; return a ResearchReport.

    Never raises. Any failure along the way degrades to a lower-fidelity
    but still shaped `ResearchReport`.
    """
    gh_state = get_github_integration_ready(sb, project_id)

    if isinstance(gh_state, GithubReadyErr):
        chat_log(
            "warn",
            "research_github_not_ready",
            project_id=project_id,
            reason=gh_state.reason,
        )
        # Without GitHub we can't run the codebase track at all, but we
        # still want to gather integration drill-in evidence and run the
        # flow synthesizer on whatever we have. Build a stub
        # CodebaseTranscript so the synthesizer has something to key off.
        intg = await _safe_integration_transcript(sb, project_id, app_url)
        cb_stub = CodebaseTranscript(
            repo_full_name="(not configured)",
            default_branch=None,
            path_count=0,
            tree_truncated=False,
            tree_warnings=["GitHub integration incomplete"],
            orientation=gh_state.reason,
            entries=[
                TranscriptEntry(kind="thought", text=gh_state.reason),
            ],
            step_budget_exhausted=False,
        )

        # Still run the flow synthesizer — it can produce flows from
        # integration evidence + general best practices. Skip the
        # codebase-exploration generator (there's nothing to describe)
        # and fall back to `empty_codebase_exploration` with the reason
        # as summary.
        flow_output = await _safe_generate_flow_report(cb_stub, intg, app_url=app_url)

        integrations_skipped = _dedupe_strings(list(intg.integrations_skipped) + ["github"])

        return ResearchReport(
            summary=flow_output.summary,
            findings=flow_output_to_findings(flow_output),
            recommendedFlows=flatten_flows(flow_output),
            integrationsCovered=list(intg.integrations_covered),
            integrationsSkipped=integrations_skipped,
            drillInHighlights=list(flow_output.drillInHighlights),
            codebaseExploration=empty_codebase_exploration(
                summary=gh_state.reason,
                truncation_warnings=["GitHub integration incomplete"],
            ),
        )

    assert isinstance(gh_state, GithubReadyOk)

    # Phase 1 — both ReAct transcripts in parallel.
    cb_task = asyncio.create_task(
        _safe_codebase_transcript(
            installation_id=gh_state.installation_id,
            repo_full_name=gh_state.repo_full_name,
        )
    )
    intg_task = asyncio.create_task(
        _safe_integration_transcript(sb, project_id, app_url)
    )
    cb, intg = await asyncio.gather(cb_task, intg_task)

    # Phase 2 — both synthesis calls in parallel.
    cb_synth_task = asyncio.create_task(_safe_generate_codebase_exploration(cb))
    flow_synth_task = asyncio.create_task(
        _safe_generate_flow_report(cb, intg, app_url=app_url)
    )
    codebase_exploration, flow_output = await asyncio.gather(
        cb_synth_task, flow_synth_task
    )

    # Phase 3 — deterministic stitch.
    integrations_covered = _dedupe_strings(
        list(intg.integrations_covered) + ["github_code"]
    )
    integrations_skipped = _dedupe_strings(list(intg.integrations_skipped))

    report = ResearchReport(
        summary=flow_output.summary,
        findings=flow_output_to_findings(flow_output),
        recommendedFlows=flatten_flows(flow_output),
        integrationsCovered=integrations_covered,
        integrationsSkipped=integrations_skipped,
        drillInHighlights=list(flow_output.drillInHighlights),
        codebaseExploration=codebase_exploration,
    )

    chat_log(
        "info",
        "research_agent_ok",
        project_id=project_id,
        integrations_covered=report.integrationsCovered,
        integrations_skipped=report.integrationsSkipped,
        findings_count=len(report.findings),
        recommended_flow_count=len(report.recommendedFlows),
        core_flow_count=len(flow_output.coreFlows),
        risk_flow_count=len(flow_output.riskFocusedFlows),
        drill_in_count=len(report.drillInHighlights),
        codebase_confidence=report.codebaseExploration.confidence,
        codebase_evidence_count=len(report.codebaseExploration.keyEvidence),
    )
    return report
