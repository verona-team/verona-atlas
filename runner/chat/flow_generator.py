"""Flow-proposal generation — called by the `tool_generate_flow_proposals` node.

Port of `lib/chat/flow-generator.ts`. Uses Gemini 3.1 Pro with structured
output (`with_structured_output`) to produce up to 3 proposed flows from a
ResearchReport. On replace-style regenerations, the generator also receives
the prior row's flows + the orchestrator's intent string so it can decide
which ids to re-emit verbatim (preservation) vs. invent new ones
(clean-slate).

## Output shape parity

The metadata dict returned by `serialize_flows_for_message` MUST match the
shape the React UI expects:

    metadata = {
      "type": "flow_proposals",
      "status": "active",                 # always "active" on insert
      "superseded_by_message_id": None,   # stamped later when replaced
      "proposals": { "analysis": str, "flows": [ProposedFlow, ...] },
      "flow_states": { <flow_id>: "pending" | "approved" | "rejected", ... },
    }

`components/chat/flow-proposal-card.tsx` reads `metadata.proposals.flows`
and `metadata.flow_states[flow.id]` directly, so field names and nesting
are load-bearing. Do not reorganize without a matching client change.

## Preservation model

The server's carry-over rule is mechanical: any new flow whose id matches a
prior id (and whose prior state was `approved`/`rejected`) inherits that
state. All other new flows start `pending`. The *decision* to preserve a
flow is made by this generator when it chooses to re-emit an id verbatim;
the server has no opinion.

To protect against accidental id collisions (the generator emitting a brand-
new flow with a coincidentally-matching prior id), `dedupe_and_avoid`
suffix-renames any collision whose name/steps differ substantially from
the prior flow of that id.
"""
from __future__ import annotations

import json
import time
from typing import Any, Literal

from pydantic import BaseModel, Field

from runner.chat.logging import chat_log
from runner.chat.models import get_gemini_pro


# ----- Pydantic schemas -----


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
    description: str = Field(
        description=(
            "2-3 sentences describing what this test flow does. State the "
            "specific user journey being exercised, the concrete UI surfaces "
            "or interactions involved, and what success looks like — written "
            "so a non-technical reader gets a clear mental picture of what "
            "the test will actually do, not just what it validates."
        )
    )
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


# ----- Prior-flow summary type (input only, not persisted) -----


class PriorFlowSummary(BaseModel):
    """Compact view of a prior flow, passed back to the generator on replace.

    Not persisted anywhere — this is just the shape `tool_generate_flow_proposals`
    builds when it reads the active row before handing off to the generator.
    """

    id: str
    name: str
    rationale: str
    state: Literal["pending", "approved", "rejected"]


# ----- Generator -----


async def generate_flow_proposals(
    *,
    app_url: str,
    research_report: dict[str, Any],
    prior_flows: list[PriorFlowSummary] | None = None,
    avoid_ids: list[str] | None = None,
    intent: str | None = None,
) -> FlowProposals:
    """Call Gemini 3.1 Pro to produce up to 3 concrete, approvable flow proposals.

    Args:
        app_url: Base URL the agent will navigate from.
        research_report: ResearchReport dict for the project.
        prior_flows: On replace-style regenerations, the summary of the
            (soon-to-be-superseded) active row's flows, INCLUDING each
            flow's current approval state. The generator uses this to
            decide which to re-emit verbatim (preservation) and which to
            drop or replace.
        avoid_ids: Ids the generator must NOT reuse except for intentional
            re-emission (same id, same steps) to preserve a flow. Typically
            the ids from `prior_flows`.
        intent: The orchestrator's one-line summary of user intent
            (`reason` from the `generate_flow_proposals` tool call).
            Embedded verbatim so the generator knows whether the user
            wants additive preservation or a clean slate.
    """
    report = research_report or {}
    findings = report.get("findings") or []
    codebase = report.get("codebaseExploration") or {}
    recommended = report.get("recommendedFlows") or []
    integrations_covered = report.get("integrationsCovered") or []
    integrations_skipped = report.get("integrationsSkipped") or []
    drill_in_highlights = report.get("drillInHighlights") or []

    # Per-finding rawData rendering lets the flow generator ground
    # rationales in concrete numbers/URLs/IDs. Kept small (500 chars per
    # finding) so the synthesis-curated anchors survive to the generator
    # without ballooning its prompt.
    _FG_RAW_DATA_CAP = 500

    def _fg_render_raw(raw: Any) -> str:
        if raw is None:
            return ""
        text = raw if isinstance(raw, str) else json.dumps(raw, default=str)
        if len(text) > _FG_RAW_DATA_CAP:
            text = text[:_FG_RAW_DATA_CAP] + f"… [+{len(text) - _FG_RAW_DATA_CAP} chars]"
        return text

    if findings:
        fg_lines: list[str] = []
        for f in findings:
            header = (
                f"[{f.get('source', '?')}] ({f.get('severity', '?')}) "
                f"{f.get('category', '?')}: {f.get('details', '')}"
            )
            raw = _fg_render_raw(f.get("rawData"))
            if raw.strip():
                fg_lines.append(f"{header}\n  evidence: {raw}")
            else:
                fg_lines.append(header)
        findings_block = "\n".join(fg_lines)
    else:
        findings_block = "No specific findings from integrations."

    drill_in_block = ""
    if drill_in_highlights:
        drill_in_lines = ["## Drill-in highlights (specific sandbox evidence)"]
        for i, h in enumerate(drill_in_highlights):
            s = (h or "").strip()
            if s:
                drill_in_lines.append(f"{i + 1}. {s}")
        if len(drill_in_lines) > 1:
            drill_in_block = "\n".join(drill_in_lines)

    codebase_block = ""
    if codebase and codebase.get("summary"):
        flows = codebase.get("inferredUserFlows") or []
        paths = codebase.get("keyPathsExamined") or []
        key_evidence = codebase.get("keyEvidence") or []
        evidence_lines: list[str] = []
        for s in key_evidence[:6]:
            path = (s.get("path") or "").strip()
            snippet = s.get("snippet") or ""
            relevance = (s.get("relevance") or "").strip()
            if not path or not snippet:
                continue
            header = f"- `{path}` — {relevance}" if relevance else f"- `{path}`"
            evidence_lines.append(header)
            evidence_lines.append("  ```")
            for raw_line in snippet.splitlines() or [snippet]:
                evidence_lines.append(f"  {raw_line}")
            evidence_lines.append("  ```")
        evidence_section = (
            "\n\nCode evidence:\n" + "\n".join(evidence_lines)
            if evidence_lines
            else ""
        )
        codebase_block = f"""## Repository understanding ({codebase.get('confidence', '?')} confidence)
{codebase.get('summary', '')}

Architecture: {codebase.get('architecture') or '—'}

Inferred flows from code: {'; '.join(flows) if flows else '—'}

Testing implications: {codebase.get('testingImplications') or '—'}
Key paths: {', '.join(paths[:30]) or '—'}{evidence_section}"""

    prior_block, id_rules_block = _build_prior_context_blocks(
        prior_flows=prior_flows,
        avoid_ids=avoid_ids,
        intent=intent,
    )

    prompt = f"""You are a QA strategist producing UI test flow proposals for {app_url}. Your output feeds directly into approvable cards in the user's chat UI and an AI browser agent that will execute approved flows.

{prior_block}# Selection rules

- Return AT MOST 3 flows. Prefer fewer (even 1) if only a couple of findings truly dominate risk. Never return 0.
- Every flow must be grounded in a specific finding from the research below — a commit SHA, PR number, URL, route, error message, rage-click page, or code reference. If you can't anchor a flow to evidence, drop it.
- Prioritise by user impact and freshness: critical for things actively breaking for real users; high for risky areas of heavy recent change; medium/low only when higher-priority candidates are already covered.
- Avoid near-duplicates. If two candidates test the same underlying change, merge them or drop the weaker one.
- Always include at least one happy-path smoke flow touching auth + a core journey UNLESS a direct regression flow already exercises that path.

# Flow schema requirements

- `id`: short, unique, kebab-case. Descriptive (e.g. `sheet-autosave-conflict`), not generic (`flow-1`).
- `name`: 4–8 words, human-readable.
- `description`: 2-3 sentences describing what the flow does. Name the specific user journey being walked, the key UI surfaces or interactions the test touches (page, button, form, modal, etc.), and what observable success looks like. Write it in user terms so a non-technical reader gets a clear mental picture of the test, not a one-line summary.
- `rationale`: one or two sentences citing the concrete evidence (e.g. "PR #206 replaced the pipeline (33 files changed)" or "290 rage clicks on /w/*/sheets in the last 14 days").
- `priority`: critical | high | medium | low.
- `steps`: ordered, executable, self-contained instructions for a browser agent that starts from a blank browser. Include credentials/test-account hints only if the research explicitly provides them.

{id_rules_block}# Step-writing rules

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
{chr(10) + drill_in_block if drill_in_block else ''}

{codebase_block}

## Candidate flow ideas (from research — use as inspiration, do not copy verbatim)
{chr(10).join(f"{i+1}. {f}" for i, f in enumerate(recommended))}

## Coverage
Investigated: {', '.join(integrations_covered) or 'none'}
Skipped: {', '.join(integrations_skipped) or 'none'}

# Output formatting

Do not include any emoji characters in the analysis, flow names, descriptions, rationales, or steps. Use plain text only."""

    model = get_gemini_pro()
    structured = model.with_structured_output(FlowProposals, method="json_schema")
    chat_log(
        "info",
        "flow_generator_llm_begin",
        finding_count=len(findings),
        recommended_count=len(recommended),
        integrations_covered=integrations_covered,
        integrations_skipped=integrations_skipped,
        prior_flow_count=len(prior_flows or []),
        avoid_id_count=len(avoid_ids or []),
        has_intent=bool(intent),
    )
    t0 = time.time()
    try:
        output = await structured.ainvoke(prompt)
    except Exception as e:
        chat_log(
            "error",
            "flow_generator_llm_failed",
            elapsed_s=round(time.time() - t0, 3),
            err=repr(e),
        )
        raise

    chat_log(
        "info",
        "flow_generator_llm_ok",
        elapsed_s=round(time.time() - t0, 3),
        flow_count=len(output.flows),
        flow_names=[f.name for f in output.flows],
        flow_priorities=[f.priority for f in output.flows],
        flow_ids=[f.id for f in output.flows],
    )
    return output


def _build_prior_context_blocks(
    *,
    prior_flows: list[PriorFlowSummary] | None,
    avoid_ids: list[str] | None,
    intent: str | None,
) -> tuple[str, str]:
    """Return the (prior-context, id-rules) prompt blocks.

    Split out so the bootstrap case (no prior flows) produces empty strings
    and the prompt reads cleanly, rather than having to carry stub sections
    that say "n/a".
    """
    if not prior_flows:
        # Bootstrap: no prior context, no avoid list.
        return (
            "",
            """# Id rules

- `id` must be globally unique within your response and stable enough that
  the same conceptual flow would use the same id on a future regeneration.
- Do not use generic ids like `flow-1`, `test-a`, etc.

""",
        )

    intent_line = (intent or "").strip()
    if not intent_line:
        # Defensive: the orchestrator should always pass an intent, but if
        # it doesn't, give the generator a neutral default that biases
        # toward preservation rather than clean-slate (safer user outcome —
        # worst case the user approves fewer things than they should have
        # to re-approve).
        intent_line = (
            "user asked to regenerate flow proposals; preserve any currently "
            "approved flows unless clearly inappropriate"
        )

    prior_lines = []
    for pf in prior_flows:
        prior_lines.append(
            f"- id={pf.id} · state={pf.state} · name={pf.name}\n"
            f"  rationale: {pf.rationale}"
        )
    prior_flows_block = "\n".join(prior_lines) if prior_lines else "(none)"

    avoid_block = ", ".join(avoid_ids or []) if avoid_ids else "(none)"

    prior_block = f"""# Regeneration context

This is a REPLACE-style regeneration. An active proposals row already exists; your output will supersede it.

User intent for this regeneration (verbatim from the orchestrator):
> {intent_line}

Previously proposed flows (id · state · name, with one-line rationale):
{prior_flows_block}

Avoid-list (do NOT reuse any of these ids EXCEPT to intentionally preserve the exact prior flow — same id, same steps):
{avoid_block}

"""

    id_rules_block = """# Id rules (critical — read carefully)

You decide, per flow, whether to PRESERVE a prior flow or introduce a NEW one:

- **Preserve**: emit a flow with the EXACT SAME `id` AND the EXACT SAME `steps` as the prior flow. The server copies the prior approval state onto your re-emission, so the user keeps their approval. Use this only when the user wants that prior flow to remain.
- **Introduce**: emit a flow with a brand-new kebab-case `id` that does NOT appear in the avoid-list above. The server marks it `pending`.

Match your id choices to the user's stated intent:

- Additive intent ("also add X", "more flows for Y") → re-emit every currently-approved prior flow verbatim AND add the new flows the user asked for.
- Refinement intent ("swap flow Z", "replace the checkout one") → re-emit prior flows the user wants to keep verbatim; introduce new flows for the ones being swapped.
- Clean-slate intent ("fresh ones", "completely regenerate", "start over", "new set") → do NOT re-emit any prior id. Use all new ids. The user wants a blank slate; their prior approvals should not be silently preserved.

If the intent line above is ambiguous, bias toward preservation of currently-approved prior flows — worst case the user rejects them, which is recoverable; silently dropping an approval is not.

Every non-re-emitted id must be genuinely new (kebab-case, descriptive, not a near-miss of a prior id like `login-smoke-2`). Do not pad with filler flows just to hit 3 — fewer high-quality flows beats duplicates.

"""

    return prior_block, id_rules_block


def dedupe_and_avoid(
    flows: list[ProposedFlow],
    *,
    prior_flows: list[PriorFlowSummary] | None = None,
    avoid_ids: list[str] | None = None,
) -> list[ProposedFlow]:
    """Harden ids before insert:

    1. Within-batch dedup: if the generator accidentally emitted two flows
       with the same id, suffix the later ones (`-2`, `-3`, …). Carried
       over from the original `dedupe_flow_ids` — see its docstring.

    2. Against-avoid-list renaming: if a flow id appears in `avoid_ids`
       (which are the prior row's ids) but the flow's name differs
       substantially from the prior flow of that same id, treat the
       collision as accidental and suffix-rename. This protects the
       carry-over loop from silently resurrecting an approval the user
       wanted gone. Intentional re-emissions (name matches) keep their id.

       "Substantially different name" is conservatively defined: exact
       match (case-insensitive, whitespace-normalized) counts as
       intentional; anything else is treated as accidental. Steps aren't
       compared here because the generator may legitimately tighten a
       step without meaning to drop the preservation intent — the name
       is the human-readable anchor.
    """
    prior_by_id: dict[str, PriorFlowSummary] = {
        pf.id: pf for pf in (prior_flows or [])
    }
    avoid_set: set[str] = set(avoid_ids or [])

    seen_in_batch: dict[str, int] = {}
    out: list[ProposedFlow] = []
    for f in flows:
        desired_id = f.id
        rename_reason: str | None = None

        # Rule 2 — collision with prior id.
        if desired_id in avoid_set:
            prior = prior_by_id.get(desired_id)
            if prior is None or not _names_match(f.name, prior.name):
                rename_reason = "accidental_prior_id_collision"

        if rename_reason:
            new_id = _suffix_until_unique(
                base=desired_id,
                taken=avoid_set | set(seen_in_batch.keys()),
            )
            chat_log(
                "warn",
                "flow_generator_dedupe_rename",
                reason=rename_reason,
                original_id=desired_id,
                new_id=new_id,
                flow_name=f.name,
            )
            desired_id = new_id

        # Rule 1 — within-batch dedup.
        n = seen_in_batch.get(desired_id, 0) + 1
        seen_in_batch[desired_id] = n
        if n > 1:
            unique_id = _suffix_until_unique(
                base=desired_id,
                taken=avoid_set | set(seen_in_batch.keys()) | {f.id for f in out},
            )
            seen_in_batch[unique_id] = 1
            desired_id = unique_id

        if desired_id != f.id:
            out.append(f.model_copy(update={"id": desired_id}))
        else:
            out.append(f)

    return out


def _names_match(a: str, b: str) -> bool:
    """Loose name-equality: case-insensitive, collapsed whitespace."""
    return " ".join(a.lower().split()) == " ".join(b.lower().split())


def _suffix_until_unique(*, base: str, taken: set[str]) -> str:
    """Return `base-2`, `base-3`, … until one is not in `taken`."""
    i = 2
    while True:
        candidate = f"{base}-{i}"
        if candidate not in taken:
            return candidate
        i += 1


def serialize_flows_for_message(
    proposals: FlowProposals,
    *,
    prior_flow_states: dict[str, str] | None = None,
    prior_flows: list[PriorFlowSummary] | None = None,
    avoid_ids: list[str] | None = None,
) -> tuple[str, dict[str, Any], list[ProposedFlow]]:
    """Return `(content, metadata, flows)` for inserting a `chat_messages` row.

    The metadata shape MUST match the client's expectations:
        metadata.type   = 'flow_proposals'
        metadata.status = 'active'
        metadata.superseded_by_message_id = None
        metadata.proposals  = { analysis, flows: [...] }
        metadata.flow_states = { <id>: 'pending' | 'approved' | 'rejected', ... }

    Carry-over is opt-in: if a new flow's id matches an entry in
    `prior_flow_states` with state `approved`/`rejected`, that state is
    copied onto the new row. Otherwise the flow starts `pending`.
    """
    flows = dedupe_and_avoid(
        list(proposals.flows),
        prior_flows=prior_flows,
        avoid_ids=avoid_ids,
    )
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

    prior_states = prior_flow_states or {}
    flow_states: dict[str, str] = {}
    carry_over_ids: list[str] = []
    for f in flows:
        prior = prior_states.get(f.id)
        if prior in ("approved", "rejected"):
            flow_states[f.id] = prior
            carry_over_ids.append(f.id)
        else:
            flow_states[f.id] = "pending"

    if prior_states:
        chat_log(
            "info",
            "flow_generator_carry_over",
            total_new_flows=len(flows),
            carried_over_count=len(carry_over_ids),
            carried_over_ids=carry_over_ids,
            prior_flow_count=len(prior_states),
        )

    metadata: dict[str, Any] = {
        "type": "flow_proposals",
        "status": "active",
        "superseded_by_message_id": None,
        "proposals": proposals_for_storage.model_dump(mode="json"),
        "flow_states": flow_states,
    }

    return content, metadata, flows
