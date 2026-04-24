"""System prompt + formatting helpers for the orchestrator agent.

Ported from the TS system prompt in `app/api/chat/route.ts` (lines 323-376).
Kept as a function rather than a template string so future nodes that need
a variant (e.g. the nightly job's synthetic bootstrap) can compose from the
same building blocks.
"""
from __future__ import annotations

import json
from typing import Any


# Per-finding rawData rendering caps. Synthesis is prompted to keep each
# rawData blob under ~500 chars, but models occasionally ignore length
# hints; we cap here so a single runaway finding can't drown the rest of
# the prompt. The cap is per-finding, not per-prompt, so a report with
# many well-sized findings still preserves each one.
_RAW_DATA_PER_FINDING_CHAR_CAP = 600


def _format_raw_data(raw: Any) -> str:
    """Best-effort render of a finding's `rawData` for a human/LLM reader.

    `rawData` is stored as a JSON-encoded string by synthesis (matches the
    TS schema's "string, not object" shape — Anthropic structured-output
    chokes on unconstrained nested JSON). We try to pretty-print if it
    parses, and fall back to the raw string otherwise.
    """
    if raw is None:
        return ""
    text = raw if isinstance(raw, str) else json.dumps(raw, default=str)
    try:
        parsed = json.loads(text)
        text = json.dumps(parsed, indent=2, default=str)
    except (TypeError, ValueError):
        pass
    if len(text) > _RAW_DATA_PER_FINDING_CHAR_CAP:
        text = (
            text[:_RAW_DATA_PER_FINDING_CHAR_CAP]
            + f"\n[...truncated {len(text) - _RAW_DATA_PER_FINDING_CHAR_CAP} more chars]"
        )
    return text


def _format_findings(findings: list[dict[str, Any]]) -> str:
    """Render findings with their supporting `rawData` when present.

    Historically `rawData` was stripped here, which defeated the purpose
    of having synthesis curate JSON anchors — the orchestrator Opus call
    never saw them. We now render each finding as a header line plus an
    optional fenced evidence block, so Opus can cite exact numbers, IDs,
    and URLs in its replies.
    """
    if not findings:
        return "No specific findings from integrations."
    blocks: list[str] = []
    for f in findings:
        src = f.get("source", "?")
        sev = f.get("severity", "?")
        cat = f.get("category", "")
        details = f.get("details", "")
        header = (
            f"- [{src}/{sev}{'/' + cat if cat else ''}] {details}"
        )
        raw = _format_raw_data(f.get("rawData"))
        if raw.strip():
            fence = "```"
            # Use json fence when parse succeeded (has `{` or `[` prefix
            # after formatting), text fence otherwise. Lets chat readers
            # still render monospace when we fall back to a non-JSON blob.
            lang = "json" if raw.lstrip().startswith(("{", "[")) else ""
            blocks.append(f"{header}\n  {fence}{lang}\n{raw}\n  {fence}")
        else:
            blocks.append(header)
    return "\n".join(blocks)


def _format_drill_in_highlights(highlights: list[str] | None) -> str:
    """Render synthesis-curated integration drill-in highlights.

    Empty list / legacy-row-without-the-field => empty string, so the
    prompt doesn't sprout a dangling header. Non-empty list renders as a
    numbered section under a dedicated header.
    """
    if not highlights:
        return ""
    lines = [
        "## Drill-in highlights (specific evidence from sandbox research)",
    ]
    for i, h in enumerate(highlights):
        s = (h or "").strip()
        if not s:
            continue
        lines.append(f"{i + 1}. {s}")
    if len(lines) == 1:
        return ""
    return "\n".join(lines)


# Codebase evidence rendering cap: each snippet is already ≤600 chars
# (enforced in the codebase agent) but we cap the count here so the
# orchestrator prompt stays bounded even if the agent emits more. We
# keep the order the agent chose — it's the model's judgment of
# priority.
_CODE_EVIDENCE_MAX_SNIPPETS = 8


def _format_code_evidence(snippets: list[dict[str, Any]] | None) -> str:
    """Render the codebase agent's self-curated code snippets.

    Each snippet is rendered as a labelled code fence plus the agent's
    one-sentence relevance note. We use a plain ``` fence rather than
    inferring a per-path language because picking a language from path
    extension is noisy for files Opus has never seen (e.g. route files
    with unusual extensions, Go .templ, etc.) and the `path` header
    already identifies the file.
    """
    if not snippets:
        return ""
    lines: list[str] = ["**Code evidence (quoted from files actually read):**"]
    for s in snippets[:_CODE_EVIDENCE_MAX_SNIPPETS]:
        path = (s.get("path") or "").strip()
        snippet = s.get("snippet") or ""
        relevance = (s.get("relevance") or "").strip()
        if not path or not snippet:
            continue
        lines.append(f"- `{path}` — {relevance}" if relevance else f"- `{path}`")
        lines.append("  ```")
        for raw_line in snippet.splitlines() or [snippet]:
            lines.append(f"  {raw_line}")
        lines.append("  ```")
    if len(lines) == 1:
        return ""
    return "\n".join(lines)


def _format_codebase_block(codebase: dict[str, Any] | None) -> str:
    if not codebase or not codebase.get("summary"):
        return ""
    flows = codebase.get("inferredUserFlows") or []
    paths = codebase.get("keyPathsExamined") or []
    warnings = codebase.get("truncationWarnings") or []
    key_evidence = codebase.get("keyEvidence") or []
    notes = f"\n**Notes:** {' '.join(warnings)}" if warnings else ""
    evidence_block = _format_code_evidence(key_evidence)
    evidence_section = f"\n\n{evidence_block}" if evidence_block else ""

    return f"""## Repository understanding ({codebase.get('confidence', '?')} confidence)
{codebase.get('summary', '')}

**Architecture:** {codebase.get('architecture') or '—'}

**Inferred user flows (from code):**
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(flows)) if flows else '—'}

**Testing implications:** {codebase.get('testingImplications') or '—'}

**Paths examined:** {', '.join(paths[:40]) if paths else '—'}{notes}{evidence_section}"""


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
    drill_in_block = _format_drill_in_highlights(report.get("drillInHighlights"))
    drill_in_section = f"\n\n{drill_in_block}" if drill_in_block else ""
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
{findings}{drill_in_section}

{codebase_block}

## Recommended flow ideas (raw — use as input when calling `generate_flow_proposals`)
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(recommended))}

Integrations covered: {', '.join(integrations_covered) or 'none'}

# Session state
{'Flow proposals already exist for this session. Refer to them by name rather than regenerating, unless the user explicitly asks to refresh or add more.' if has_existing_proposals else 'No flow proposals exist yet for this session.'}{flow_status}{context_block}{runs_block}"""
