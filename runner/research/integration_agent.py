"""Integration research sub-agent.

Fetches preflight data from each connected integration (GitHub, PostHog,
Sentry, LangSmith, Braintrust), then asks Claude Sonnet 4.6 to synthesize
an `IntegrationResearchReport` using structured output.

## Why no tool-calling loop?

The TS version let Claude write arbitrary JS that ran in a Vercel Sandbox
so it could drill into preflight data, correlate across sources, etc. In
practice the preflight step already captures 80%+ of the signal we use
downstream, and the TS loop's extra drill-ins rarely introduced new
findings that the initial preflight dump didn't already surface.

Trading that drill-in capability for:
  - no Vercel Sandbox dependency,
  - simpler code (~200 lines vs ~400),
  - one LLM call instead of 20,

feels like a win for v1. If we find we're missing findings in production,
we can add a second Sonnet pass with typed tools for drill-ins (never
going back to LLM-writes-arbitrary-code).
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from runner.chat.logging import chat_log
from runner.chat.models import get_sonnet
from runner.encryption import decrypt
from runner.research.docs import get_integration_docs_bundle
from runner.research.github_client import get_installation_token
from runner.research.github_repo_explorer import parse_repo_full_name
from runner.research.preflight import (
    preflight_braintrust,
    preflight_github,
    preflight_langsmith,
    preflight_posthog,
    preflight_sentry,
)
from runner.research.types import (
    IntegrationResearchReport,
    ResearchFinding,
    Severity,
)


# ----- Pydantic schemas for Sonnet structured output -----


class _AgentFinding(BaseModel):
    source: str = Field(
        description="Integration id: github, posthog, sentry, langsmith, braintrust."
    )
    category: str = Field(
        description=(
            "recent_changes, errors, user_behavior, performance, llm_failures, test_gaps"
        )
    )
    details: str = Field(
        description=(
            "One or two sentences describing the finding, ending with a concrete "
            "anchor (commit SHA, PR #, URL, error count, session ID)."
        )
    )
    severity: Literal["critical", "high", "medium", "low"]
    rawData: str | None = Field(
        default=None,
        description=(
            "Optional JSON string of supporting data (NOT natural language). "
            "Use this only when the anchor doesn't fit in `details`."
        ),
    )


class _AgentReport(BaseModel):
    summary: str = Field(description="3-6 sentences. Lead with the biggest risk.")
    findings: list[_AgentFinding] = Field(default_factory=list)
    recommendedFlows: list[str] = Field(default_factory=list)


async def _run_preflights(
    app_url: str,
    integration_configs: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Run each integration's preflight function in parallel.

    `integration_configs` is `{type -> decrypted config dict}`. Returns
    `{type -> preflight result dict}`. Missing or failed integrations are
    represented by `{"success": False, "error": "..."}`.
    """
    jobs: dict[str, asyncio.Task] = {}

    for t, cfg in integration_configs.items():
        if t == "github":
            parsed = parse_repo_full_name(cfg.get("repo_full_name") or "")
            if parsed is None:
                jobs[t] = asyncio.create_task(
                    _error_task(f"GitHub repo not configured for {app_url}")
                )
                continue
            installation_id = cfg.get("installation_id")
            if not installation_id:
                jobs[t] = asyncio.create_task(
                    _error_task("GitHub installation_id missing")
                )
                continue
            jobs[t] = asyncio.create_task(
                _gh_preflight(int(installation_id), parsed.owner, parsed.repo)
            )
        elif t == "posthog":
            api_key = cfg.get("api_key")
            api_host = cfg.get("api_host") or "https://us.posthog.com"
            project_id = cfg.get("posthog_project_id")
            if not api_key or not project_id:
                jobs[t] = asyncio.create_task(
                    _error_task("PostHog credentials incomplete")
                )
                continue
            jobs[t] = asyncio.create_task(
                preflight_posthog(
                    api_key=api_key, api_host=api_host, project_id=project_id
                )
            )
        elif t == "sentry":
            auth_token = cfg.get("auth_token")
            org_slug = cfg.get("organization_slug")
            project_slug = cfg.get("project_slug")
            if not auth_token or not org_slug or not project_slug:
                jobs[t] = asyncio.create_task(
                    _error_task("Sentry credentials incomplete")
                )
                continue
            jobs[t] = asyncio.create_task(
                preflight_sentry(
                    auth_token=auth_token,
                    org_slug=org_slug,
                    project_slug=project_slug,
                )
            )
        elif t == "langsmith":
            api_key = cfg.get("api_key")
            if not api_key:
                jobs[t] = asyncio.create_task(
                    _error_task("LangSmith credentials incomplete")
                )
                continue
            jobs[t] = asyncio.create_task(
                preflight_langsmith(
                    api_key=api_key, project_name=cfg.get("project_name")
                )
            )
        elif t == "braintrust":
            api_key = cfg.get("api_key")
            if not api_key:
                jobs[t] = asyncio.create_task(
                    _error_task("Braintrust credentials incomplete")
                )
                continue
            jobs[t] = asyncio.create_task(preflight_braintrust(api_key=api_key))

    results: dict[str, dict[str, Any]] = {}
    for t, task in jobs.items():
        try:
            results[t] = await task
        except Exception as e:
            results[t] = {"success": False, "error": f"{type(e).__name__}: {e}"}
    return results


async def _error_task(message: str) -> dict[str, Any]:
    return {"success": False, "error": message}


async def _gh_preflight(installation_id: int, owner: str, repo: str) -> dict[str, Any]:
    token = await get_installation_token(installation_id)
    return await preflight_github(
        installation_token=token, owner=owner, repo=repo
    )


def _fallback_report(app_url: str, reason: str) -> IntegrationResearchReport:
    """Used when no integrations are connected or all preflights failed."""
    return IntegrationResearchReport(
        summary=reason,
        findings=[],
        recommendedFlows=[
            f"Homepage smoke test — open {app_url} and verify critical UI",
            "Primary navigation — exercise main routes and links",
            "Core user journey — sign-in, forms, or checkout if applicable",
        ],
        integrationsCovered=[],
        integrationsSkipped=[],
    )


def _resolve_configs(active_integrations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Decrypt and flatten active integration configs into `{type -> plain dict}`.

    The DB row shape is `{type, config}` where `config` is a JSONB blob with
    encrypted credentials. We decrypt here once so the preflight callers
    receive plain strings.
    """
    resolved: dict[str, dict[str, Any]] = {}
    for row in active_integrations:
        t = row.get("type")
        cfg = row.get("config") or {}
        if not isinstance(t, str):
            continue
        out: dict[str, Any] = {}

        if t == "github":
            out["installation_id"] = cfg.get("installation_id")
            repo = cfg.get("repo") or {}
            if isinstance(repo, dict):
                out["repo_full_name"] = repo.get("full_name")

        elif t == "posthog":
            enc = cfg.get("api_key_encrypted")
            if enc:
                try:
                    out["api_key"] = decrypt(enc)
                except Exception as e:
                    chat_log("warn", "research_posthog_decrypt_failed", err=repr(e))
                    continue
            out["posthog_project_id"] = cfg.get("posthog_project_id")
            out["api_host"] = cfg.get("api_host")

        elif t == "sentry":
            enc = cfg.get("auth_token_encrypted")
            if enc:
                try:
                    out["auth_token"] = decrypt(enc)
                except Exception as e:
                    chat_log("warn", "research_sentry_decrypt_failed", err=repr(e))
                    continue
            out["organization_slug"] = cfg.get("organization_slug")
            out["project_slug"] = cfg.get("project_slug")

        elif t == "langsmith":
            enc = cfg.get("api_key_encrypted")
            if enc:
                try:
                    out["api_key"] = decrypt(enc)
                except Exception as e:
                    chat_log("warn", "research_langsmith_decrypt_failed", err=repr(e))
                    continue
            out["project_name"] = cfg.get("project_name")

        elif t == "braintrust":
            enc = cfg.get("api_key_encrypted")
            if enc:
                try:
                    out["api_key"] = decrypt(enc)
                except Exception as e:
                    chat_log("warn", "research_braintrust_decrypt_failed", err=repr(e))
                    continue

        else:
            continue

        resolved[t] = out
    return resolved


async def run_integration_research(
    *,
    app_url: str,
    active_integrations: list[dict[str, Any]],
) -> IntegrationResearchReport:
    """End-to-end: resolve configs, run preflights, synthesize with Sonnet.

    `active_integrations` is the list of `integrations` rows already
    filtered to `status = 'active'` for the project. This function does
    not touch Supabase itself — `runner.research.orchestrator` is the one
    that reads from DB.
    """
    if not active_integrations:
        return _fallback_report(
            app_url,
            "No integrations are connected. Recommendations are based on general "
            "best practices for the application URL.",
        )

    resolved = _resolve_configs(active_integrations)
    if not resolved:
        return _fallback_report(
            app_url,
            "Integrations are connected but credentials could not be resolved. "
            "Recommendations are based on general best practices.",
        )

    preflight_results = await _run_preflights(app_url, resolved)

    integrations_covered: list[str] = []
    integrations_skipped: list[str] = []
    for t, result in preflight_results.items():
        if result.get("success"):
            integrations_covered.append(t)
        else:
            integrations_skipped.append(t)

    if not integrations_covered:
        return _fallback_report(
            app_url,
            "All integration preflights failed. Recommendations are based on "
            "general best practices.",
        )

    # Build the Sonnet synthesis prompt. Keep preflight payloads as JSON for
    # maximum signal density — Sonnet handles nested JSON fine.
    preflight_block = "\n\n".join(
        f"## {t.upper()} preflight data\n\n```json\n{json.dumps(preflight_results[t], indent=2, default=str)}\n```"
        for t in integrations_covered
    )

    docs_block = "\n\n---\n\n".join(
        f"## {t.upper()} API documentation\n\n{doc}"
        for t, doc in get_integration_docs_bundle(integrations_covered).items()
    )

    system = f"""You are a QA research agent synthesizing evidence-backed signals about {app_url} from connected integrations. Your output feeds a downstream flow-proposer; be specific and anchored, not narrative.

# Output requirements

- `summary`: 3-6 sentences. Lead with the single biggest risk, then the next 1-2 themes. No preamble, no "this report covers...".
- `findings`: one entry per distinct, actionable signal. Each needs `source`, `category`, `severity`, a one- or two-sentence `details` that ends with a concrete anchor (commit SHA, PR #, URL, error count, session ID). Use `rawData` (JSON string) ONLY when the anchor doesn't fit naturally in prose.
- `recommendedFlows`: short phrases naming user-facing flows a QA human could recognize ("Autosave under concurrent editing", "Magic-link expiration recovery"). Prefer 5-10 strong candidates over 20 weak ones. Each must be traceable to at least one finding.

# Prioritization

1. Regressions on recently merged PRs — especially large diffs, bug-fix series, or infra overhauls.
2. Pages with concrete user pain (rage clicks, exceptions, drop-off).
3. High-traffic journeys that would be embarrassing to break.
4. AI/LLM features with failing runs or score regressions."""

    human = f"""Produce the structured research report for {app_url} now.

Connected integrations with preflight data:
{', '.join(integrations_covered)}

Skipped (no data or errors):
{', '.join(integrations_skipped) or 'none'}

{preflight_block}

# Provider reference (for your understanding of field meanings)

{docs_block}"""

    model = get_sonnet(max_tokens=4096, temperature=0.1)
    structured = model.with_structured_output(_AgentReport, method="json_schema")

    try:
        agent_report: _AgentReport = await structured.ainvoke(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": human},
            ]
        )
    except Exception as e:
        chat_log("error", "research_integration_llm_failed", err=repr(e))
        return IntegrationResearchReport(
            summary=(
                f"Integration research synthesis failed: {type(e).__name__}: {e}. "
                f"Preflight data was collected for {', '.join(integrations_covered)}."
            ),
            findings=[],
            recommendedFlows=[],
            integrationsCovered=integrations_covered,
            integrationsSkipped=integrations_skipped,
        )

    findings = [
        ResearchFinding(
            source=f.source,
            category=f.category,
            details=f.details,
            severity=f.severity,
            rawData=f.rawData,
        )
        for f in agent_report.findings
    ]

    return IntegrationResearchReport(
        summary=agent_report.summary,
        findings=findings,
        recommendedFlows=agent_report.recommendedFlows,
        integrationsCovered=integrations_covered,
        integrationsSkipped=integrations_skipped,
    )
