"""Pydantic models mirroring `lib/research-agent/types.ts`.

These are the canonical shapes for the `chat_sessions.research_report`
column. Field names are EXACTLY the TS ones (snake_case would break the
TS reader `normalizeResearchReport`), even though that's slightly
un-Pythonic.

Round-tripping:

    python_report.model_dump(mode="json")  # -> dict ready for supabase.jsonb
    ResearchReport.model_validate(raw_from_db)  # -> typed object

The TS `researchReportSchema.safeParse(...)` on the other end MUST succeed
for any value we write here. The test harness in Phase 2d round-trips a
fixture through both sides to lock this invariant.

This module also hosts the internal-only *transcript* types used between
the ReAct loops (codebase / integration) and the synthesis stage. Those
never touch the DB — they're in-memory scaffolding for the two-call
synthesis (codebase-exploration generator + unified flow synthesizer) —
so they're plain dataclasses rather than pydantic models, and they
intentionally live alongside the public types to keep the research
package's type surface in one place.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

Severity = Literal["critical", "high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]


class ResearchFinding(BaseModel):
    """One evidence-backed signal the research agent surfaced.

    `source` identifies the integration/track: `github`, `github_code`,
    `posthog`, `sentry`, `langsmith`, `braintrust`.

    `rawData` is a JSON-encoded string (not an object) — matches the TS
    schema which had to do this to keep provider structured-output happy
    (and existing rows in the DB encode it the same way). We don't parse
    it on write; treat it as opaque supporting evidence.
    """

    source: str
    category: str
    details: str
    severity: Severity
    rawData: str | None = None


class CodebaseEvidenceSnippet(BaseModel):
    """A short, quoted snippet from a file the codebase agent actually read.

    Added so the final chat orchestrator (and the flow generator) can cite
    code-level evidence that no other track can produce — integration
    sub-agents never see file contents, and the compressed
    `architecture` / `testingImplications` paragraphs lose per-file nuance.

    The agent self-curates these at finish time: it's looking back at the
    handful of files that most informed its conclusions and pulling a
    representative line or two from each. Capped in size by prompt, not
    code, so we preserve whatever the model chose.
    """

    path: str = Field(description="Repository path this snippet came from.")
    snippet: str = Field(
        description=(
            "Verbatim excerpt (≤ ~400 chars) from the file showing what "
            "informed the finding."
        )
    )
    relevance: str = Field(
        description=(
            "One short sentence on why this snippet matters for QA planning."
        )
    )


class CodebaseExplorationResult(BaseModel):
    """Output of the codebase-exploration sub-agent.

    All fields mirror the TS `codebaseExplorationResultSchema`. `confidence`
    reflects how much coverage the agent got — low means GitHub errored,
    the repo was huge and truncated, or the step budget ran out before a
    meaningful cross-section was read.

    `keyEvidence` is optional (empty list on older rows) and carries a
    few short, self-curated code snippets the agent read. This is the
    one channel that survives the "sub-agent compressed raw evidence
    into prose" step with actual, quoteable code preserved.
    """

    summary: str
    architecture: str
    inferredUserFlows: list[str]
    testingImplications: str
    keyPathsExamined: list[str]
    confidence: Confidence
    truncationWarnings: list[str]
    toolStepsUsed: int
    keyEvidence: list[CodebaseEvidenceSnippet] = Field(default_factory=list)


class IntegrationResearchReport(BaseModel):
    """Output of the integration-research sub-agent (pre-merge with codebase).

    `drillInHighlights` is a small list of synthesis-curated one-liners
    naming specific sandbox drill-in results worth surfacing (e.g.
    "PostHog confirms 48 `$exception` events on `/w/*/sheets/*` post-PR
    #206, up from 2 the prior week"). This is a dedicated channel for
    signals that don't fit the `ResearchFinding` shape but are too
    concrete to fold into the top-level `summary`. Empty list on older
    rows; see `drill-in research notes` in the synthesis prompt for the
    contract.
    """

    summary: str
    findings: list[ResearchFinding]
    recommendedFlows: list[str]
    integrationsCovered: list[str]
    integrationsSkipped: list[str]
    drillInHighlights: list[str] = Field(default_factory=list)


class ResearchReport(IntegrationResearchReport):
    """Merged integration + codebase report — the full `research_report` jsonb.

    Inherits the integration shape and adds `codebaseExploration`. Override
    `summary` semantics: after merge, it combines both tracks.
    """

    codebaseExploration: CodebaseExplorationResult


def empty_codebase_exploration(
    *,
    summary: str = "No repository analysis was performed.",
    architecture: str = "",
    inferred_user_flows: list[str] | None = None,
    testing_implications: str = "",
    key_paths_examined: list[str] | None = None,
    confidence: Confidence = "low",
    truncation_warnings: list[str] | None = None,
    tool_steps_used: int = 0,
    key_evidence: list[CodebaseEvidenceSnippet] | None = None,
) -> CodebaseExplorationResult:
    """Default / error-case codebase exploration result.

    Used when GitHub integration isn't ready, exploration loop errored,
    or exploration finished without calling the finish tool.
    """
    return CodebaseExplorationResult(
        summary=summary,
        architecture=architecture,
        inferredUserFlows=list(inferred_user_flows or []),
        testingImplications=testing_implications,
        keyPathsExamined=list(key_paths_examined or []),
        confidence=confidence,
        truncationWarnings=list(truncation_warnings or []),
        toolStepsUsed=tool_steps_used,
        keyEvidence=list(key_evidence or []),
    )


# Helper for node_modules-style "soft validate" — accepts a possibly-partial
# JSON blob from DB and fills defaults rather than raising. Keeps the reader
# resilient to schema drift on older rows (same role as TS's normalizeResearchReport).
def normalize_research_report(raw: object | None) -> ResearchReport | None:
    """Parse a `chat_sessions.research_report` value, filling defaults.

    Returns None if `raw` is None; otherwise returns a best-effort
    `ResearchReport`. Prefer calling this over direct `model_validate` on
    data coming from the DB, because older rows may predate some fields.
    """
    if raw is None:
        return None
    try:
        return ResearchReport.model_validate(raw)
    except Exception:
        if not isinstance(raw, dict):
            return ResearchReport(
                summary="Research report unavailable.",
                findings=[],
                recommendedFlows=[],
                integrationsCovered=[],
                integrationsSkipped=[],
                codebaseExploration=empty_codebase_exploration(
                    summary="Research report unavailable.",
                ),
            )
        patched = dict(raw)
        patched.setdefault("findings", [])
        patched.setdefault("recommendedFlows", [])
        patched.setdefault("integrationsCovered", [])
        patched.setdefault("integrationsSkipped", [])
        patched.setdefault("drillInHighlights", [])
        patched.setdefault(
            "codebaseExploration",
            empty_codebase_exploration().model_dump(mode="json"),
        )
        # Back-compat: older rows predate keyEvidence on the nested
        # codebaseExploration object. Fill it in so validation passes.
        if isinstance(patched.get("codebaseExploration"), dict):
            patched["codebaseExploration"].setdefault("keyEvidence", [])
        patched.setdefault("summary", "Research report partially available.")
        return ResearchReport.model_validate(patched)


# ---------------------------------------------------------------------------
# Internal-only transcript types (in-memory only; never persisted to DB)
# ---------------------------------------------------------------------------
#
# After the revamp, each ReAct loop (codebase, integration) produces a
# `*Transcript` capturing the full investigation log — every tool call
# and every natural-language thought block. These transcripts are fed
# into two independent LLM synthesis calls:
#
#   - `generate_codebase_exploration(codebase_transcript)` →
#       CodebaseExplorationResult (first-class field on ResearchReport)
#   - `generate_flow_report(codebase_transcript, integration_transcript,
#       app_url)` → synthesizer output (merged into ResearchReport)
#
# The synthesis step has the full transcript budget to work with (1M
# context window on Gemini 3.1 Pro) so the transcript entries are kept
# un-summarized here. Rendering / eviction to stay under a soft token
# cap happens in `runner.research.synthesizer.render_transcript`.


@dataclass
class TranscriptEntry:
    """One entry in a per-track investigation transcript.

    Two entry shapes, distinguished by `kind`:

    - `kind="thought"`: a natural-language text block the investigator
      LLM emitted alongside (or instead of) a tool call. Captures
      reasoning — e.g. "Sentry issue SHEETS-1234 points at ReactEditor;
      let me pull commits touching that file next." `text` is populated;
      all tool-specific fields are None.

    - `kind="tool_call"`: a single tool invocation plus its result.
      `tool`, `args`, and `result` are populated. `exit_code` is
      populated only for the integration track's `execute_code` tool
      (Python sandbox exit code); it's None for every other tool.

    The shape is intentionally uniform across tracks so the renderer
    (`render_transcript`) can walk a single list of entries without
    branching per track.
    """

    kind: Literal["thought", "tool_call"]
    text: str | None = None
    tool: str | None = None
    args: dict[str, Any] | None = None
    result: Any | None = None
    exit_code: int | None = None


@dataclass
class CodebaseTranscript:
    """Output of the codebase-exploration ReAct loop.

    `orientation` is the final AIMessage text emitted when the loop
    stopped calling tools — a 3-5 sentence handoff blurb. Falls back to
    "" when the loop was cut off by step-budget exhaustion or an error.

    `tool_steps_used` counts only `kind="tool_call"` entries (thoughts
    are free). This replaces the old `toolStepsUsed` field the
    `finish_codebase_exploration` tool used to populate.
    """

    repo_full_name: str
    default_branch: str | None
    path_count: int
    tree_truncated: bool
    tree_warnings: list[str] = field(default_factory=list)
    orientation: str = ""
    entries: list[TranscriptEntry] = field(default_factory=list)
    step_budget_exhausted: bool = False

    @property
    def tool_steps_used(self) -> int:
        return sum(1 for e in self.entries if e.kind == "tool_call")


@dataclass
class IntegrationTranscript:
    """Output of the integration-research ReAct loop.

    `preflight_results` carries the per-provider preflight JSON
    verbatim; the synthesizer sees it as a fenced JSON block per
    integration, not filtered or projected. `integrations_covered` /
    `integrations_skipped` are derived from preflight `success` so the
    downstream ResearchReport can report them deterministically.

    `sandbox_available` is False when Modal sandbox creation failed;
    entries in that case will be empty and the flow synthesizer falls
    back to preflight-only reasoning.
    """

    app_url: str
    integrations_covered: list[str] = field(default_factory=list)
    integrations_skipped: list[str] = field(default_factory=list)
    preflight_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    orientation: str = ""
    entries: list[TranscriptEntry] = field(default_factory=list)
    step_budget_exhausted: bool = False
    sandbox_available: bool = True

    @property
    def exec_count(self) -> int:
        return sum(
            1
            for e in self.entries
            if e.kind == "tool_call" and e.tool == "execute_code"
        )


# ---------------------------------------------------------------------------
# Synthesizer structured-output schemas (pydantic — structured output needs it)
# ---------------------------------------------------------------------------
#
# These are the shapes Gemini fills in via `with_structured_output(...,
# method="json_schema")` at the synthesis stage. They're deliberately
# kept close to the public types (`CodebaseExplorationResult`,
# `ResearchReport` fields) so the serialization path from synthesizer
# output -> ResearchReport is a near-identity projection.


class _SynthEvidenceSnippet(BaseModel):
    """Schema-side shape for a code evidence snippet.

    Mirrors `CodebaseEvidenceSnippet`. Kept as a separate pydantic model
    (rather than re-using the public one) so downstream snippet
    validation / 600-char capping can live at the serialization boundary
    instead of leaking model-level constraints into the schema the LLM
    sees.
    """

    path: str = Field(description="Repository path the snippet came from.")
    snippet: str = Field(
        description=(
            "Verbatim excerpt from the file (≤ 400 chars). Quote the "
            "actual code — do not paraphrase."
        )
    )
    relevance: str = Field(
        description=(
            "One short sentence on why this snippet matters for QA planning."
        )
    )


class CodebaseExplorationSynthOutput(BaseModel):
    """Structured output for the codebase-exploration generator call.

    This is the output schema of the FIRST synthesis-stage LLM call —
    the one whose entire job is to turn a `CodebaseTranscript` into a
    `CodebaseExplorationResult`. Fields mirror `CodebaseExplorationResult`
    except `toolStepsUsed` (filled deterministically from the transcript
    after the call returns).
    """

    summary: str = Field(
        description="3-5 sentences on what the app is and its dominant flow."
    )
    architecture: str = Field(
        description=(
            "Stack + routing model + auth strategy + notable patterns "
            "(monorepo, server actions, tRPC, etc.)."
        )
    )
    inferredUserFlows: list[str] = Field(
        description=(
            "Concrete UI-level user flows a user actually does, each phrased "
            "as a short action (e.g. 'Sign in with magic link', 'Create a "
            "new sheet and add columns'). Derive from routes / pages / "
            "components."
        )
    )
    testingImplications: str = Field(
        description=(
            "Risks a QA human should prioritize given what was seen "
            "(auth surface area, payment flows, forms with complex "
            "validation, new or heavily churned modules, accessibility)."
        )
    )
    keyPathsExamined: list[str] = Field(
        description=(
            "Files actually read by the investigator that informed this "
            "description. Pull directly from the transcript's "
            "get_file_content tool calls."
        )
    )
    confidence: Confidence = Field(
        description=(
            "high / medium / low. Use low if the transcript shows API "
            "errors, the tree was truncated, or step budget ran out."
        )
    )
    truncationWarnings: list[str] = Field(
        default_factory=list,
        description=(
            "Honest list of gaps (e.g. 'Could not read src/lib/payments — "
            "GitHub returned 404'). Include any tree warnings from the "
            "transcript's repo-index metadata."
        ),
    )
    keyEvidence: list[_SynthEvidenceSnippet] = Field(
        default_factory=list,
        description=(
            "3-6 short verbatim snippets from files actually read that most "
            "reveal user-visible behaviour (auth checks, route wiring, "
            "form validation, mutations). Each has path, a verbatim "
            "snippet (≤400 chars), and a one-sentence relevance note."
        ),
    )


class _SynthFinding(BaseModel):
    """Structured-output shape of a finding (projected to ResearchFinding)."""

    source: str = Field(
        description=(
            "Integration id: github, github_code, posthog, sentry, "
            "langsmith, braintrust."
        )
    )
    category: str = Field(
        description=(
            "recent_changes, errors, user_behavior, performance, "
            "llm_failures, test_gaps, codebase_structure, or a similarly "
            "short snake_case tag."
        )
    )
    details: str = Field(
        description=(
            "One or two sentences describing the finding, ending with a "
            "concrete anchor (commit SHA, PR #, URL, error count, session "
            "ID)."
        )
    )
    severity: Severity
    rawData: str | None = Field(
        default=None,
        description=(
            "Optional JSON-encoded string with supporting data (IDs, URLs, "
            "short lists). Keep under ~500 chars."
        ),
    )


class FlowSynthOutput(BaseModel):
    """Structured output for the unified flow synthesizer call.

    Deliberately does NOT include `codebaseExploration` — that lives in
    its own sibling call (`CodebaseExplorationSynthOutput`). Keeping
    this call narrowly scoped to flow generation / finding curation is
    the whole point of the two-call split.

    `coreFlows` and `riskFocusedFlows` are emitted separately so the
    60/40 coverage ratio is explicit in the output rather than a
    prompt-only aspiration. They're flattened into the public
    `ResearchReport.recommendedFlows: list[str]` at the serialization
    edge.
    """

    summary: str = Field(
        description=(
            "3-6 sentences synthesizing both investigations. Lead with the "
            "biggest risk, then cover 1-2 further themes. No preamble."
        )
    )
    findings: list[_SynthFinding] = Field(
        default_factory=list,
        description=(
            "One entry per distinct, actionable signal — drawn from the "
            "integration drill-ins, the repo exploration, or both. Each "
            "must end `details` with a concrete anchor."
        ),
    )
    coreFlows: list[str] = Field(
        default_factory=list,
        description=(
            "Long-horizon user journeys a signed-in user does in a typical "
            "session — NOT tied to any specific recent change. Each flow "
            "MUST be a multi-step sequence of 4-8 concrete UI interactions "
            "connected by arrows (→). Authentication, if required, is the "
            "FIRST step of a larger flow, never the whole flow. Target "
            "~60% of total flows."
        ),
    )
    riskFocusedFlows: list[str] = Field(
        default_factory=list,
        description=(
            "Long-horizon flows anchored to specific recent evidence (a "
            "PR, rage-click, Sentry issue, LangSmith failure). Each must "
            "cite the anchor in the flow description and still be a "
            "4-8 step sequence with arrows (→). Target ~40% of total "
            "flows."
        ),
    )
    drillInHighlights: list[str] = Field(
        default_factory=list,
        description=(
            "3-6 one-sentence callouts naming SPECIFIC drill-in results "
            "from the integration transcript. Each MUST cite a concrete "
            "number or anchor pulled from the transcript (e.g. 'PostHog: "
            "48 $exception events on /w/*/sheets/* in the last 7 days, up "
            "from 2 the prior week'). Skip only if drill-ins produced "
            "nothing useful."
        ),
    )
