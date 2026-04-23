"""System prompt + formatting helpers for the orchestrator agent.

Ported from the TS system prompt in `app/api/chat/route.ts` (lines 323-376).
Kept as a function rather than a template string so future nodes that need
a variant (e.g. the nightly job's synthetic bootstrap) can compose from the
same building blocks.
"""
from __future__ import annotations

import json
from typing import Any


def _format_findings(findings: list[dict[str, Any]]) -> str:
    if not findings:
        return "No specific findings from integrations."
    lines: list[str] = []
    for f in findings:
        src = f.get("source", "?")
        sev = f.get("severity", "?")
        details = f.get("details", "")
        lines.append(f"- [{src}/{sev}] {details}")
    return "\n".join(lines)


def _format_codebase_block(codebase: dict[str, Any] | None) -> str:
    if not codebase or not codebase.get("summary"):
        return ""
    flows = codebase.get("inferredUserFlows") or []
    paths = codebase.get("keyPathsExamined") or []
    warnings = codebase.get("truncationWarnings") or []
    notes = f"\n**Notes:** {' '.join(warnings)}" if warnings else ""

    return f"""## Repository understanding ({codebase.get('confidence', '?')} confidence)
{codebase.get('summary', '')}

**Architecture:** {codebase.get('architecture') or '—'}

**Inferred user flows (from code):**
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(flows)) if flows else '—'}

**Testing implications:** {codebase.get('testingImplications') or '—'}

**Paths examined:** {', '.join(paths[:40]) if paths else '—'}{notes}"""


def _format_flow_status_summary(
    latest_flow_proposals: dict[str, Any] | None,
) -> str:
    if not latest_flow_proposals or latest_flow_proposals.get("type") != "flow_proposals":
        return ""
    proposals = latest_flow_proposals.get("proposals") or {}
    flows = proposals.get("flows") if isinstance(proposals, dict) else None
    flow_states = latest_flow_proposals.get("flow_states") or {}
    if not isinstance(flows, list) or not flows:
        return ""
    lines = ["", "", "Current flow states:"]
    for f in flows:
        fid = f.get("id") if isinstance(f, dict) else None
        name = f.get("name") if isinstance(f, dict) else None
        state = flow_states.get(fid, "pending") if isinstance(fid, str) else "pending"
        lines.append(f"- {name}: {state}")
    return "\n".join(lines)


def build_orchestrator_system_prompt(
    *,
    project_name: str,
    app_url: str,
    research_report: dict[str, Any] | None,
    latest_flow_proposals: dict[str, Any] | None,
    context_summary: str | None,
    recent_runs: list[dict[str, Any]] | None,
) -> str:
    """Return the full system prompt for the Opus orchestrator.

    Byte-compatible with the TS version's wording so behavior is stable
    across the TS->Python cutover; any behavior changes we want to make
    should be done as follow-up commits we can A/B.
    """
    has_existing_proposals = bool(
        latest_flow_proposals and latest_flow_proposals.get("type") == "flow_proposals"
    )

    report = research_report or {}
    findings = _format_findings(report.get("findings") or [])
    codebase_block = _format_codebase_block(report.get("codebaseExploration"))
    recommended = report.get("recommendedFlows") or []
    integrations_covered = report.get("integrationsCovered") or []
    report_summary = report.get("summary") or ""

    runs_block = (
        f"\nRecent test runs:\n{json.dumps(list(recent_runs or []), indent=2, default=str)}"
        if recent_runs
        else ""
    )
    context_block = (
        f"\nPrior conversation summary:\n{context_summary}" if context_summary else ""
    )

    flow_status = _format_flow_status_summary(latest_flow_proposals)

    return f"""You are Verona, an AI QA strategist helping teams plan and execute UI testing for their web app.

Project: "{project_name}" ({app_url})

# Tools — read carefully

You have two tools. The product's UI depends on them; do not try to substitute prose for tool output.

1. `generate_flow_proposals` — renders proposed test flows as structured, approvable cards in the chat UI. This is the ONLY way the user can approve a flow.
2. `start_test_run` — executes the flows the user has approved.

## When to call `generate_flow_proposals`

Call it whenever the user wants to see, propose, refresh, or add test flows — including the very first turn of a session, or phrasings like "suggest flows", "what should I test", "give me tests", "recommend flows", "propose more", "anything else to cover".

After the tool returns, reply with AT MOST two sentences that point the user at the cards and invite approval. Example: "I've proposed three flows above — approve the ones you want and tell me to start testing." Never repeat or re-describe the flows' names, steps, or rationales in prose; the cards already show them.

## When to call `start_test_run`

Call it when the user confirms they want to run approved flows ("start testing", "go", "run them", "let's do it"). After it returns, reply with one short sentence confirming execution started.

## What NOT to write in prose

Never write numbered lists, bullets, or prose that describes candidate flows ("Flow 1:", "Flow 2:", "Here are the flows I recommend:", "I suggest testing X, Y, Z"). If you catch yourself about to do this, stop and call `generate_flow_proposals` instead.

# Style

- Lead with the decision or answer in one short paragraph. Bullets only when they aid scanning.
- No preamble ("I'll analyze…", "Let me look at…"). No recap of the research report unless asked.
- When referencing findings, cite one concrete anchor per point (a commit, an error, a route, a rage-click count). One clause, not an essay.
- When the user gives feedback, acknowledge in one or two sentences and say what you'll do next.
- If the user asks about data from an integration not in "Integrations covered" below, tell them to connect it in Settings.
- Never use emojis in your responses. Do not include any emoji characters or pictographs under any circumstances, even for lists, status, or emphasis. Use plain text only.

# Research report (background context — do not recite)

## Summary
{report_summary}

## Key findings
{findings}

{codebase_block}

## Recommended flow ideas (raw — use as input when calling `generate_flow_proposals`)
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(recommended))}

Integrations covered: {', '.join(integrations_covered) or 'none'}

# Session state
{'Flow proposals already exist for this session. Refer to them by name rather than regenerating, unless the user explicitly asks to refresh or add more.' if has_existing_proposals else 'No flow proposals exist yet for this session.'}{flow_status}{context_block}{runs_block}"""
