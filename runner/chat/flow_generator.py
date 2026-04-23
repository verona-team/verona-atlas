"""Flow-proposal generation — called by the `tool_generate_flow_proposals` node.

Port of `lib/chat/flow-generator.ts`. Uses Claude Sonnet 4.6 with structured
output (`with_structured_output`) to produce up to 3 proposed flows from a
ResearchReport.

## Output shape parity

The metadata dict returned by `serialize_flows_for_message` MUST match the
shape the React UI expects:

    metadata = {
      "type": "flow_proposals",
      "proposals": { "analysis": str, "flows": [ProposedFlow, ...] },
      "flow_states": { <flow_id>: "pending", ... },
    }

`components/chat/flow-proposal-card.tsx` reads `metadata.proposals.flows`
and `metadata.flow_states[flow.id]` directly, so field names and nesting
are load-bearing. Do not reorganize without a matching client change.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from runner.chat.logging import chat_log
from runner.chat.models import get_sonnet


# ----- Pydantic schemas (match lib/test-planner.ts + flow-generator.ts) -----


class TemplateStep(BaseModel):
    order: int
    instruction: str
    type: Literal["navigate", "action", "assertion", "extract", "wait"]
    url: str | None = None
    expected: str | None = None
    timeout: int | None = None


class ProposedFlow(BaseModel):
    id: str = Field(description="Unique identifier for this flow proposal")
    name: str = Field(description="Short descriptive name for the test flow")
    description: str = Field(description="What this test flow validates")
    rationale: str = Field(
        description="Why this flow is recommended — reference specific findings"
    )
    priority: Literal["critical", "high", "medium", "low"]
    steps: list[TemplateStep]


class FlowProposals(BaseModel):
    analysis: str = Field(
        description="Very brief analysis (2-3 sentences max) of what matters most"
    )
    flows: list[ProposedFlow] = Field(max_length=3)


# ----- Generator -----


async def generate_flow_proposals(
    *,
    app_url: str,
    research_report: dict[str, Any],
) -> FlowProposals:
    """Call Sonnet to produce up to 3 concrete, approvable flow proposals."""
    report = research_report or {}
    findings = report.get("findings") or []
    codebase = report.get("codebaseExploration") or {}
    recommended = report.get("recommendedFlows") or []
    integrations_covered = report.get("integrationsCovered") or []
    integrations_skipped = report.get("integrationsSkipped") or []

    findings_block = (
        "\n".join(
            f"[{f.get('source', '?')}] ({f.get('severity', '?')}) {f.get('category', '?')}: {f.get('details', '')}"
            for f in findings
        )
        if findings
        else "No specific findings from integrations."
    )

    codebase_block = ""
    if codebase and codebase.get("summary"):
        flows = codebase.get("inferredUserFlows") or []
        paths = codebase.get("keyPathsExamined") or []
        codebase_block = f"""## Repository understanding ({codebase.get('confidence', '?')} confidence)
{codebase.get('summary', '')}

Architecture: {codebase.get('architecture') or '—'}

Inferred flows from code: {'; '.join(flows) if flows else '—'}

Testing implications: {codebase.get('testingImplications') or '—'}
Key paths: {', '.join(paths[:30]) or '—'}"""

    prompt = f"""You are a QA strategist producing UI test flow proposals for {app_url}. Your output feeds directly into approvable cards in the user's chat UI and an AI browser agent that will execute approved flows.

# Selection rules

- Return AT MOST 3 flows. Prefer fewer (even 1) if only a couple of findings truly dominate risk. Never return 0.
- Every flow must be grounded in a specific finding from the research below — a commit SHA, PR number, URL, route, error message, rage-click page, or code reference. If you can't anchor a flow to evidence, drop it.
- Prioritise by user impact and freshness: critical for things actively breaking for real users; high for risky areas of heavy recent change; medium/low only when higher-priority candidates are already covered.
- Avoid near-duplicates. If two candidates test the same underlying change, merge them or drop the weaker one.
- Always include at least one happy-path smoke flow touching auth + a core journey UNLESS a direct regression flow already exercises that path.

# Flow schema requirements

- `id`: short, unique, kebab-case. Descriptive (e.g. `sheet-autosave-conflict`), not generic (`flow-1`).
- `name`: 4–8 words, human-readable.
- `description`: one sentence stating what the flow validates, in user terms.
- `rationale`: one or two sentences citing the concrete evidence (e.g. "PR #206 replaced the pipeline (33 files changed)" or "290 rage clicks on /w/*/sheets in the last 14 days").
- `priority`: critical | high | medium | low.
- `steps`: ordered, executable, self-contained instructions for a browser agent that starts from a blank browser. Include credentials/test-account hints only if the research explicitly provides them.

# Step-writing rules

- First step is almost always `navigate` to an absolute URL starting from {app_url}.
- Each step does ONE thing. Break compound actions apart.
- `action` steps name the target element ("click the 'Add column' button in the toolbar") and what to type when relevant.
- `assertion` steps state the concrete observable ("the new column 'Full Name' appears as the rightmost header and persists after reload").
- Add a `wait` step only when a real async boundary exists (autosave flush, network fetch, job completion) — don't pad.
- Include `url` on navigate steps. Include `expected` on assertion steps. Set `timeout` only when a step legitimately needs longer than default (e.g. long-running enrichment).
- Steps should be numbered sequentially from 1.

# Analysis field

2-3 sentences. State the single biggest risk and why the proposed flows address it. Do not restate flow names or counts.

# Research context

## Executive summary
{report.get('summary', '')}

## Findings
{findings_block}

{codebase_block}

## Candidate flow ideas (from research — use as inspiration, do not copy verbatim)
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(recommended))}

## Coverage
Investigated: {', '.join(integrations_covered) or 'none'}
Skipped: {', '.join(integrations_skipped) or 'none'}

# Output formatting

Do not include any emoji characters in the analysis, flow names, descriptions, rationales, or steps. Use plain text only."""

    model = get_sonnet(max_tokens=4096, temperature=0.2)
    structured = model.with_structured_output(FlowProposals, method="json_schema")
    try:
        output = await structured.ainvoke(prompt)
    except Exception as e:
        chat_log("error", "flow_generator_llm_failed", err=repr(e))
        raise

    return output


def dedupe_flow_ids(flows: list[ProposedFlow]) -> list[ProposedFlow]:
    """Ensure every flow.id is unique across the batch.

    LLMs occasionally return two flows with the same kebab-case id, which
    would collapse in `flow_states[id]` and cause one approval to apply to
    both cards. We suffix collisions deterministically.
    """
    seen: dict[str, int] = {}
    out: list[ProposedFlow] = []
    for f in flows:
        n = seen.get(f.id, 0) + 1
        seen[f.id] = n
        if n == 1:
            out.append(f)
        else:
            out.append(f.model_copy(update={"id": f"{f.id}-{n}"}))
    return out


def serialize_flows_for_message(
    proposals: FlowProposals,
) -> tuple[str, dict[str, Any], list[ProposedFlow]]:
    """Return `(content, metadata, flows)` for inserting a `chat_messages` row.

    The metadata shape MUST match the client's expectations:
        metadata.type = 'flow_proposals'
        metadata.proposals = { analysis, flows: [...] }
        metadata.flow_states = { <id>: 'pending', ... }
    """
    flows = dedupe_flow_ids(list(proposals.flows))
    proposals_for_storage = FlowProposals(analysis=proposals.analysis, flows=flows)

    flow_list_prose = "\n\n".join(
        f"**{i+1}. {f.name}** ({f.priority} priority)\n{f.description}\n_Rationale: {f.rationale}_\n{len(f.steps)} steps"
        for i, f in enumerate(flows)
    )

    content = (
        f"{proposals.analysis}\n\n"
        f"**Flows to test (max 3):**\n\n"
        f"{flow_list_prose}\n\n"
        f"Approve, reject, or edit each; say when to start testing."
    )

    flow_states: dict[str, str] = {f.id: "pending" for f in flows}
    metadata: dict[str, Any] = {
        "type": "flow_proposals",
        "proposals": proposals_for_storage.model_dump(mode="json"),
        "flow_states": flow_states,
    }

    return content, metadata, flows
