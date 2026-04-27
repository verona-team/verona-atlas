"""Unit tests for `runner.research.synthesizer`.

Covers the deterministic parts (transcript rendering + eviction) and
the fallback paths of the two LLM-backed calls. The LLM calls are
mocked by patching the model factories on the `synthesizer` module:
`get_gemini_pro` for the codebase-exploration synthesis call (still
on Gemini for its long context window), and
`get_claude_opus_flow_synthesis` for the unified flow-synthesis call
(now on Opus 4.7). The shared `_FakeModel` / `_RaisingModel` classes
support both factories' `with_structured_output(...)` shape.

Runnable standalone:

    python3 -m runner.research.test_synthesizer
"""
from __future__ import annotations

import asyncio
import os
import sys

os.environ.setdefault("SUPABASE_URL", "https://x")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
os.environ.setdefault("ANTHROPIC_API_KEY", "x")
os.environ.setdefault("GOOGLE_API_KEY", "x")

from runner.research import synthesizer
from runner.research.synthesizer import (
    PER_TRACK_SOFT_TOKEN_CAP,
    _CHARS_PER_TOKEN,
    _evict_for_cap,
    _codebase_stub,
    _integration_stub,
    flatten_flows,
    flow_output_to_findings,
    generate_codebase_exploration,
    generate_flow_report,
    render_codebase_transcript,
    render_integration_transcript,
)
from runner.research.types import (
    CodebaseExplorationSynthOutput,
    CodebaseTranscript,
    FlowSynthOutput,
    IntegrationTranscript,
    TranscriptEntry,
    _SynthEvidenceSnippet,
    _SynthFinding,
)


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


# ---------------------------------------------------------------------------
# Rendering tests
# ---------------------------------------------------------------------------


def test_render_codebase_basic() -> None:
    cb = CodebaseTranscript(
        repo_full_name="acme/app",
        default_branch="main",
        path_count=42,
        tree_truncated=False,
        tree_warnings=[],
        orientation="Next.js app with Clerk auth and Stripe billing.",
        entries=[
            TranscriptEntry(kind="thought", text="Start with package.json."),
            TranscriptEntry(
                kind="tool_call",
                tool="get_repo_ref",
                args={},
                result={"defaultBranch": "main", "pathCount": 42},
            ),
            TranscriptEntry(
                kind="tool_call",
                tool="get_file_content",
                args={"path": "package.json"},
                result={
                    "ok": True,
                    "path": "package.json",
                    "size": 1024,
                    "truncated": False,
                    "content": '{"name": "acme", "version": "1.0.0"}',
                },
            ),
            TranscriptEntry(
                kind="tool_call",
                tool="list_repo_paths",
                args={"prefix": "app/"},
                result={
                    "pathCount": 2,
                    "truncated": False,
                    "paths": ["app/page.tsx", "app/layout.tsx"],
                },
            ),
        ],
        step_budget_exhausted=False,
    )
    rendered, evictions = render_codebase_transcript(cb)
    assert evictions == 0, "small transcript should not trigger eviction"
    assert "# Codebase investigation — acme/app" in rendered
    assert "Next.js app with Clerk auth" in rendered
    # Thoughts surface BOTH in the leading aggregate AND inline.
    assert "## Investigator reasoning" in rendered
    assert rendered.count("Start with package.json.") >= 2, (
        "thought text should appear in both the aggregate section and inline"
    )
    assert "[thought]" in rendered
    assert "[tool:get_repo_ref]" in rendered
    assert "[tool:get_file_content path=package.json" in rendered
    assert '"name": "acme"' in rendered
    assert "[tool:list_repo_paths prefix='app/']" in rendered
    assert "app/page.tsx" in rendered
    # Aggregate section should appear BEFORE the chronological log.
    assert rendered.index("## Investigator reasoning") < rendered.index("## Exploration log")
    print(_green("  ok: codebase transcript renders with header + entries"))


def test_render_integration_basic() -> None:
    intg = IntegrationTranscript(
        app_url="https://acme.dev",
        integrations_covered=["github", "posthog"],
        integrations_skipped=["langsmith"],
        preflight_results={
            "github": {"success": True, "commits": {"total": 3}},
            "posthog": {"success": True, "top_rage_clicks": []},
            "langsmith": {"success": False, "error": "no creds"},
        },
        orientation="Sentry shows TypeError spike.",
        entries=[
            TranscriptEntry(kind="thought", text="Let me drill into PR #42."),
            TranscriptEntry(
                kind="tool_call",
                tool="execute_code",
                args={"purpose": "List files changed in PR #42"},
                result={
                    "purpose": "List files changed in PR #42",
                    "explanation": "fetch PR files",
                    "exit_code": 0,
                    "code": "import httpx\nprint('hi')",
                    "stdout": '{"pr": 42, "files": ["a.ts"]}',
                    "stderr": "",
                },
                exit_code=0,
            ),
        ],
        step_budget_exhausted=False,
        sandbox_available=True,
    )
    rendered, evictions = render_integration_transcript(intg)
    assert evictions == 0
    assert "# Integration investigation — https://acme.dev" in rendered
    assert "Sentry shows TypeError spike." in rendered
    assert "## Integrations covered\ngithub, posthog" in rendered
    assert "## Integrations skipped\nlangsmith" in rendered
    assert "### GITHUB" in rendered
    assert "### POSTHOG" in rendered
    assert "### LANGSMITH" in rendered  # skipped still rendered
    assert "[tool:execute_code] exit=0" in rendered
    assert "List files changed in PR #42" in rendered
    assert "import httpx" in rendered
    # Investigator reasoning aggregate present and ordered before the drill-in log.
    assert "## Investigator reasoning" in rendered
    assert rendered.count("Let me drill into PR #42.") >= 2
    assert rendered.index("## Investigator reasoning") < rendered.index("## Drill-in log")
    print(_green("  ok: integration transcript renders with preflight + exec log"))


def test_render_codebase_file_error() -> None:
    cb = CodebaseTranscript(
        repo_full_name="acme/app",
        default_branch="main",
        path_count=0,
        tree_truncated=False,
        tree_warnings=[],
        orientation="",
        entries=[
            TranscriptEntry(
                kind="tool_call",
                tool="get_file_content",
                args={"path": "missing.tsx"},
                result={"ok": False, "path": "missing.tsx", "error": "Not found"},
            ),
        ],
        step_budget_exhausted=False,
    )
    rendered, _ = render_codebase_transcript(cb)
    assert "ERROR" in rendered
    assert "Not found" in rendered
    assert "missing.tsx" in rendered
    print(_green("  ok: codebase file-error entry renders with error"))


# ---------------------------------------------------------------------------
# Eviction tests
# ---------------------------------------------------------------------------


def test_eviction_below_cap_is_noop() -> None:
    entries = [
        TranscriptEntry(
            kind="tool_call",
            tool="get_file_content",
            args={"path": f"f{i}.ts"},
            result={"ok": True, "path": f"f{i}.ts", "size": 100, "content": "x" * 100},
        )
        for i in range(3)
    ]
    new_entries, evictions = _evict_for_cap(
        entries,
        track="codebase",
        soft_token_cap=1_000_000,
        stub_formatter=_codebase_stub,
    )
    assert evictions == 0
    assert new_entries == entries
    print(_green("  ok: under-cap input triggers no eviction"))


def test_eviction_evicts_oldest_high_cost_first() -> None:
    # 10 file reads, each ~10KB rendered. Cap set low so eviction MUST
    # happen. We expect the oldest non-pinned entries to be stubbed.
    big_content = "x" * 10_000  # ~3K tokens per entry
    entries = [
        TranscriptEntry(
            kind="thought",
            text=f"thought before file {i}",
        )
        if i % 3 == 0
        else TranscriptEntry(
            kind="tool_call",
            tool="get_file_content",
            args={"path": f"f{i}.ts"},
            result={
                "ok": True,
                "path": f"f{i}.ts",
                "size": len(big_content),
                "content": big_content,
            },
        )
        for i in range(15)
    ]
    # Cap chosen so some (but not all) file reads must be evicted.
    new_entries, evictions = _evict_for_cap(
        entries,
        track="codebase",
        soft_token_cap=10_000,
        stub_formatter=_codebase_stub,
    )
    assert evictions > 0, "cap was well below rendered size; eviction expected"
    # All thoughts should survive.
    for i, original in enumerate(entries):
        if original.kind == "thought":
            assert (
                new_entries[i].kind == "thought"
                and new_entries[i].text == original.text
            ), "thoughts must never be evicted"
    # The last 5 file reads in the *working* list are pinned.
    hc_indices = [i for i, e in enumerate(entries) if e.tool == "get_file_content"]
    pinned_indices = set(hc_indices[-5:])
    for pi in pinned_indices:
        assert isinstance(new_entries[pi].result, dict)
        assert new_entries[pi].result.get("evicted") is not True, (
            f"index {pi} should be pinned but was evicted"
        )
    # At least one earlier high-cost entry should be evicted.
    evicted_indices = [
        i
        for i in hc_indices
        if i not in pinned_indices
        and isinstance(new_entries[i].result, dict)
        and new_entries[i].result.get("evicted") is True
    ]
    assert evicted_indices, "expected at least one old high-cost entry to be evicted"
    # Eviction order: oldest first. The first evictable high-cost
    # index should be evicted before any of the later ones.
    evictable_candidates = [i for i in hc_indices if i not in pinned_indices]
    assert evicted_indices[0] == evictable_candidates[0], (
        f"expected first-evicted index {evictable_candidates[0]}, got "
        f"{evicted_indices[0]}"
    )
    print(_green("  ok: eviction stubs oldest high-cost, pins thoughts + recent"))


def test_eviction_stub_preserves_metadata() -> None:
    entry = TranscriptEntry(
        kind="tool_call",
        tool="get_file_content",
        args={"path": "app/page.tsx"},
        result={
            "ok": True,
            "path": "app/page.tsx",
            "size": 1_000_000,
            "content": "x" * 1_000_000,
        },
    )
    stub = _codebase_stub(entry)
    assert stub.kind == "tool_call"
    assert stub.tool == "get_file_content"
    assert stub.args == {"path": "app/page.tsx"}
    assert isinstance(stub.result, dict)
    assert stub.result.get("evicted") is True
    assert stub.result.get("path") == "app/page.tsx"
    # Content field removed.
    assert "content" not in stub.result
    print(_green("  ok: codebase stub drops bulk fields but preserves metadata"))


def test_integration_eviction_stub() -> None:
    entry = TranscriptEntry(
        kind="tool_call",
        tool="execute_code",
        args={"purpose": "Drill into PR #42"},
        result={
            "purpose": "Drill into PR #42",
            "explanation": "fetched",
            "exit_code": 0,
            "code": "import httpx\n" + "x" * 5000,
            "stdout": "y" * 50_000,
            "stderr": "",
        },
        exit_code=0,
    )
    stub = _integration_stub(entry)
    assert stub.kind == "tool_call"
    assert stub.tool == "execute_code"
    assert stub.args == {"purpose": "Drill into PR #42"}
    assert isinstance(stub.result, dict)
    assert stub.result.get("evicted") is True
    assert stub.result.get("purpose") == "Drill into PR #42"
    assert stub.result.get("exit_code") == 0
    # Bulk fields gone.
    assert "stdout" not in stub.result
    assert "stderr" not in stub.result
    assert "code" not in stub.result
    print(_green("  ok: integration stub preserves purpose + exit_code, drops bulk"))


def test_render_with_eviction_emits_evicted_marker() -> None:
    # Trigger eviction on a codebase transcript and check the rendered
    # output shows the "Content evicted to stay under synthesizer token
    # cap" stub note.
    big_content = "x" * 80_000
    cb = CodebaseTranscript(
        repo_full_name="acme/big",
        default_branch="main",
        path_count=1,
        tree_truncated=False,
        tree_warnings=[],
        orientation="Big repo.",
        entries=[
            TranscriptEntry(
                kind="tool_call",
                tool="get_file_content",
                args={"path": f"f{i}.ts"},
                result={
                    "ok": True,
                    "path": f"f{i}.ts",
                    "size": 80_000,
                    "content": big_content,
                },
            )
            for i in range(20)
        ],
        step_budget_exhausted=False,
    )
    rendered, evictions = render_codebase_transcript(cb, soft_token_cap=30_000)
    assert evictions > 0, "cap was below total size; expected eviction"
    # The rendered output should contain evicted-stub markers for the
    # oldest entries.
    assert "evicted" in rendered.lower() or "to stay under" in rendered.lower()
    print(_green("  ok: render with eviction produces evicted-stub marker in output"))


# ---------------------------------------------------------------------------
# LLM-mocked synthesis tests
# ---------------------------------------------------------------------------


class _FakeStructured:
    def __init__(self, result: object):
        self._result = result

    async def ainvoke(self, _messages: object) -> object:
        return self._result


class _FakeModel:
    def __init__(self, result: object):
        self._result = result

    def with_structured_output(self, _schema: object, method: str | None = None):
        # Accepts the optional `method` kwarg the Gemini path passes
        # (`method="json_schema"`) while also tolerating the Anthropic
        # path which omits it.
        return _FakeStructured(self._result)


class _RaisingStructured:
    def __init__(self, exc: Exception):
        self._exc = exc

    async def ainvoke(self, _messages: object) -> object:
        raise self._exc


class _RaisingModel:
    def __init__(self, exc: Exception):
        self._exc = exc

    def with_structured_output(self, _schema: object, method: str | None = None):
        return _RaisingStructured(self._exc)


def _empty_cb(repo: str = "acme/app") -> CodebaseTranscript:
    return CodebaseTranscript(
        repo_full_name=repo,
        default_branch="main",
        path_count=1,
        tree_truncated=False,
        tree_warnings=[],
        orientation="Tiny orientation.",
        entries=[
            TranscriptEntry(
                kind="tool_call",
                tool="get_file_content",
                args={"path": "app/page.tsx"},
                result={
                    "ok": True,
                    "path": "app/page.tsx",
                    "size": 100,
                    "content": "export default function Page() {}",
                },
            ),
        ],
        step_budget_exhausted=False,
    )


def _empty_intg(app_url: str = "https://acme.dev") -> IntegrationTranscript:
    return IntegrationTranscript(
        app_url=app_url,
        integrations_covered=["github"],
        integrations_skipped=[],
        preflight_results={"github": {"success": True, "commits": {"total": 0}}},
        orientation="Quiet last 7 days.",
        entries=[],
        step_budget_exhausted=False,
        sandbox_available=True,
    )


def test_codebase_exploration_projection() -> None:
    """LLM output maps to CodebaseExplorationResult; snippet cap applies."""
    fake_output = CodebaseExplorationSynthOutput(
        summary="Next.js app for sheet editing.",
        architecture="Next.js 15 App Router + Clerk + Stripe + Supabase.",
        inferredUserFlows=["Sign in with magic link", "Create a sheet"],
        testingImplications="Billing webhook is high-risk.",
        keyPathsExamined=["app/page.tsx"],
        confidence="high",
        truncationWarnings=[],
        keyEvidence=[
            _SynthEvidenceSnippet(
                path="app/page.tsx",
                snippet="x" * 1000,  # should get truncated
                relevance="main entry",
            ),
            _SynthEvidenceSnippet(
                path="app/page.tsx",
                snippet="short",
                relevance="also main entry",
            ),
        ],
    )

    original_get = synthesizer.get_gemini_pro
    synthesizer.get_gemini_pro = lambda: _FakeModel(fake_output)  # type: ignore[assignment]
    try:
        cb = _empty_cb()
        cb.tree_truncated = True
        cb.tree_warnings = ["pre-existing tree warning"]

        result = asyncio.run(generate_codebase_exploration(cb))
    finally:
        synthesizer.get_gemini_pro = original_get  # type: ignore[assignment]

    assert result.summary == "Next.js app for sheet editing."
    assert result.confidence == "high"
    assert result.toolStepsUsed == cb.tool_steps_used == 1
    # First snippet should be capped at _SNIPPET_MAX (600) with ellipsis.
    first_snippet = result.keyEvidence[0].snippet
    assert len(first_snippet) <= synthesizer._SNIPPET_MAX + 1
    assert first_snippet.endswith("…")
    # Second snippet untouched.
    assert result.keyEvidence[1].snippet == "short"
    # Tree warnings merged into truncation warnings.
    assert "pre-existing tree warning" in result.truncationWarnings
    assert any("tree API" in w for w in result.truncationWarnings)
    print(_green("  ok: codebase exploration maps + caps snippets + merges warnings"))


def test_codebase_exploration_fallback_on_error() -> None:
    """On structured-output error, returns low-confidence stub with transcript paths."""
    original_get = synthesizer.get_gemini_pro
    synthesizer.get_gemini_pro = lambda: _RaisingModel(  # type: ignore[assignment]
        RuntimeError("timeout")
    )
    try:
        cb = _empty_cb()
        result = asyncio.run(generate_codebase_exploration(cb))
    finally:
        synthesizer.get_gemini_pro = original_get  # type: ignore[assignment]

    assert result.confidence == "low"
    assert "app/page.tsx" in result.keyPathsExamined
    assert any("timeout" in w for w in result.truncationWarnings)
    assert result.summary  # non-empty
    print(_green("  ok: codebase exploration falls back on synthesis error"))


def test_flow_synthesis_projection() -> None:
    """LLM output maps cleanly and flows are flattened for ResearchReport."""
    fake_output = FlowSynthOutput(
        summary="Biggest risk is the sheet editor.",
        findings=[
            _SynthFinding(
                source="sentry",
                category="errors",
                details="TypeError spike. Issue SHEETS-1234.",
                severity="high",
                rawData='{"count": 482}',
            ),
        ],
        coreFlows=[
            "Sign in with email → open dashboard → create a sheet → add 3 columns → edit a cell → refresh page → verify persistence",
        ],
        riskFocusedFlows=[
            "Open a sheet with >10 rows (regression risk, SHEETS-1234) → select a range → copy → paste → undo → redo → save → reload → verify state",
        ],
        drillInHighlights=["Sentry SHEETS-1234: 482 events last 7d."],
    )

    original_get = synthesizer.get_claude_opus_flow_synthesis
    synthesizer.get_claude_opus_flow_synthesis = lambda: _FakeModel(fake_output)  # type: ignore[assignment]
    try:
        cb = _empty_cb()
        intg = _empty_intg()
        output = asyncio.run(generate_flow_report(cb, intg, app_url="https://acme.dev"))
    finally:
        synthesizer.get_claude_opus_flow_synthesis = original_get  # type: ignore[assignment]

    assert output.summary == "Biggest risk is the sheet editor."
    assert len(output.coreFlows) == 1
    assert len(output.riskFocusedFlows) == 1
    # Flattening puts core first.
    flat = flatten_flows(output)
    assert flat[0].startswith("Sign in with email")
    assert flat[1].startswith("Open a sheet")
    # Finding projection.
    findings = flow_output_to_findings(output)
    assert len(findings) == 1
    assert findings[0].source == "sentry"
    assert findings[0].severity == "high"
    assert findings[0].rawData == '{"count": 482}'
    print(_green("  ok: flow synthesis projects findings and flattens core+risk"))


def test_flow_synthesis_fallback_on_error() -> None:
    """On structured-output error, returns canned smoke-test fallback."""
    original_get = synthesizer.get_claude_opus_flow_synthesis
    synthesizer.get_claude_opus_flow_synthesis = lambda: _RaisingModel(  # type: ignore[assignment]
        RuntimeError("500 server error")
    )
    try:
        cb = _empty_cb()
        intg = _empty_intg()
        output = asyncio.run(generate_flow_report(cb, intg, app_url="https://acme.dev"))
    finally:
        synthesizer.get_claude_opus_flow_synthesis = original_get  # type: ignore[assignment]

    assert "flow synthesis failed" in output.summary.lower()
    assert len(output.coreFlows) >= 1
    assert output.riskFocusedFlows == []
    assert output.findings == []
    # Each core fallback flow must still be multi-step.
    for f in output.coreFlows:
        assert "→" in f, "fallback flows still include → arrows"
    print(_green("  ok: flow synthesis falls back with multi-step canned flows"))


# ---------------------------------------------------------------------------
# Constants sanity
# ---------------------------------------------------------------------------


def test_token_heuristic_sanity() -> None:
    assert _CHARS_PER_TOKEN > 0 and _CHARS_PER_TOKEN < 10
    assert PER_TRACK_SOFT_TOKEN_CAP >= 100_000
    assert PER_TRACK_SOFT_TOKEN_CAP <= 500_000
    # 300K tokens per track × 2 tracks × _CHARS_PER_TOKEN = ~2M chars
    # total worst case — safely under the model's 1M-token window once
    # tokenized.
    print(_green("  ok: constants within expected envelope"))


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def main() -> None:
    print("running synthesizer tests:")
    test_render_codebase_basic()
    test_render_integration_basic()
    test_render_codebase_file_error()
    test_eviction_below_cap_is_noop()
    test_eviction_evicts_oldest_high_cost_first()
    test_eviction_stub_preserves_metadata()
    test_integration_eviction_stub()
    test_render_with_eviction_emits_evicted_marker()
    test_codebase_exploration_projection()
    test_codebase_exploration_fallback_on_error()
    test_flow_synthesis_projection()
    test_flow_synthesis_fallback_on_error()
    test_token_heuristic_sanity()
    print(_green("all tests passed"))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(_red(f"ASSERTION FAILED: {e}"))
        sys.exit(1)
    except Exception as e:
        import traceback

        print(_red(f"UNEXPECTED ERROR: {type(e).__name__}: {e}"))
        traceback.print_exc()
        sys.exit(2)
