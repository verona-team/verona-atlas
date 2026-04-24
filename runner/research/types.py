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
"""
from __future__ import annotations

from typing import Literal

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
