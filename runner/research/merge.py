"""Merge integration + codebase sub-reports into a single ResearchReport.

Port of `lib/research-agent/merge-research-report.ts`. Same behavior:
codebase findings are projected into the unified `findings` list as
`source = 'github_code'`, inferred flows get appended to
`recommendedFlows` (deduped, capped at 20), and the summary gets the
codebase summary tacked on as a separate paragraph.
"""
from __future__ import annotations

import json

from .types import (
    CodebaseExplorationResult,
    IntegrationResearchReport,
    ResearchFinding,
    ResearchReport,
)


def _dedupe_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for s in items:
        t = s.strip()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def merge_integration_and_codebase(
    integration: IntegrationResearchReport,
    codebase: CodebaseExplorationResult,
) -> ResearchReport:
    """Combine the two research tracks into the full `ResearchReport`."""
    code_findings: list[ResearchFinding] = []

    if codebase.architecture.strip():
        code_findings.append(
            ResearchFinding(
                source="github_code",
                category="codebase_structure",
                details=codebase.architecture,
                severity="medium",
                rawData=json.dumps(
                    {
                        "confidence": codebase.confidence,
                        "keyPathsExamined": codebase.keyPathsExamined,
                    }
                ),
            )
        )

    if codebase.testingImplications.strip():
        code_findings.append(
            ResearchFinding(
                source="github_code",
                category="test_gaps",
                details=codebase.testingImplications,
                severity="high",
            )
        )

    if codebase.inferredUserFlows:
        code_findings.append(
            ResearchFinding(
                source="github_code",
                category="user_behavior",
                details=(
                    "Inferred user-visible flows from the repository: "
                    + "; ".join(codebase.inferredUserFlows)
                ),
                severity="medium",
            )
        )

    all_findings = list(integration.findings) + code_findings

    flow_extras = [f"From codebase: {f}" for f in codebase.inferredUserFlows]
    recommended_flows = _dedupe_strings(
        list(integration.recommendedFlows) + flow_extras
    )[:20]

    summary_parts = [integration.summary.strip()]
    if codebase.summary.strip():
        summary_parts.append(
            f"Repository analysis ({codebase.confidence} confidence): "
            f"{codebase.summary.strip()}"
        )
    summary = "\n\n".join(p for p in summary_parts if p)

    integrations_skipped = _dedupe_strings(list(integration.integrationsSkipped))
    integrations_covered = _dedupe_strings(
        list(integration.integrationsCovered) + ["github_code"]
    )

    return ResearchReport(
        summary=summary,
        findings=all_findings,
        recommendedFlows=recommended_flows,
        integrationsCovered=integrations_covered,
        integrationsSkipped=integrations_skipped,
        codebaseExploration=codebase,
    )
