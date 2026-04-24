"""Unified synthesis stage: transcripts -> structured research outputs.

After both ReAct loops finish, each produces a `*Transcript`. This
module turns those transcripts into the two pydantic outputs that the
orchestrator stitches into `ResearchReport`:

    1. `generate_codebase_exploration(cb)` — one Gemini 3.1 Pro call
       scoped to the codebase transcript only, producing a
       `CodebaseExplorationResult` (architecture, flows, testing
       implications, keyEvidence, confidence, etc.).

    2. `generate_flow_report(cb, intg, app_url)` — one Gemini 3.1 Pro
       call over BOTH transcripts + preflight, producing a flow-focused
       structured output (summary, findings, coreFlows, riskFocusedFlows,
       drillInHighlights).

Both calls are run concurrently from the orchestrator via
`asyncio.gather`. They don't depend on each other — neither reads the
other's output.

## Why two calls

The split is about focus and failure isolation:

- The codebase-exploration generator is a summarization problem over
  one stream (the codebase transcript). Its prompt can be narrowly
  about "describe this repo." It doesn't need to know about PostHog
  rage-clicks or Sentry issues.
- The flow synthesizer is the harder problem: given both investigations,
  produce long-horizon, well-balanced QA flows with specific coverage
  rules. Its prompt can be fully dedicated to flow quality without
  competing with repo-description duties.

If either call fails, the other's output still populates its half of
`ResearchReport` via the shared fallback helpers in
`runner.research.types`.

## Rendering + eviction

Transcripts can be large (up to 20 integration execs × 60K stdout, or
30 file reads × 30K chars each). `render_transcript(track)` turns a
`CodebaseTranscript` or `IntegrationTranscript` into a deterministic
Markdown block, evicting oldest high-cost entries if the rendered
output would exceed `PER_TRACK_SOFT_TOKEN_CAP` (300K tokens). The
eviction policy pins small / high-signal entries (thoughts,
listing/metadata calls, the N most-recent high-cost entries) and drops
oldest high-cost entries first.

Token estimation uses `len(s) / _CHARS_PER_TOKEN` with
`_CHARS_PER_TOKEN = 3.3` — a rule-of-thumb fit for Gemini's tokenizer
on JSON-heavy mixed content. Post-call we also log the model's
reported input-token count so the heuristic can be calibrated.
"""
from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from runner.chat.logging import chat_log
from runner.chat.models import get_gemini_pro
from runner.research.types import (
    CodebaseEvidenceSnippet,
    CodebaseExplorationResult,
    CodebaseExplorationSynthOutput,
    CodebaseTranscript,
    FlowSynthOutput,
    IntegrationTranscript,
    ResearchFinding,
    TranscriptEntry,
    empty_codebase_exploration,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Rough chars-per-token heuristic for Gemini 3.1 Pro on the mixed
# JSON/code/prose content our transcripts carry. Intentionally
# conservative (estimate denser than reality) so the soft cap kicks in
# slightly earlier than the model's real token count would.
_CHARS_PER_TOKEN = 3.3

# Per-track soft cap on rendered transcript tokens. Both tracks combined
# stay well under the 1M context window leaving room for system prompt,
# preflight block, output budget, and model overhead.
PER_TRACK_SOFT_TOKEN_CAP = 300_000

# How many recent high-cost entries to pin (never evict).
# "High-cost entries" means get_file_content (codebase) and execute_code
# (integration) — the ones whose output bytes dominate size.
_PINNED_RECENT_HIGH_COST = 5

# Final-output snippet cap: the prompt asks for ≤400 chars, but models
# occasionally ignore length hints. Capping here keeps the downstream
# prompt bounded regardless. Matches the pre-revamp defensive cap.
_SNIPPET_MAX = 600


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------


def _estimate_tokens(s: str) -> int:
    """Estimate token count from character count.

    Not exact — we log the real count from the LLM's usage metadata
    after each synthesis call so we can calibrate the heuristic.
    """
    return int(len(s) / _CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Entry rendering (deterministic; no LLM involvement)
# ---------------------------------------------------------------------------


def _render_json_compact(obj: Any, limit: int = 1_000_000) -> str:
    """Pretty JSON for transcript rendering, with a very high upper bound.

    The upper bound is a last-resort guard against a pathological tool
    result that somehow bypassed per-field caps; in practice we never
    hit it.
    """
    try:
        s = json.dumps(obj, indent=2, default=str)
    except Exception:
        s = str(obj)
    if len(s) > limit:
        s = s[:limit] + f"\n[...truncated {len(s) - limit} more chars]"
    return s


def _render_codebase_entry(entry: TranscriptEntry) -> str:
    """Render a single CodebaseTranscript entry as a Markdown block."""
    if entry.kind == "thought":
        return f"[thought]\n{entry.text or ''}"

    tool = entry.tool or "unknown"
    args = entry.args or {}
    result = entry.result if entry.result is not None else {}

    # Evicted stub — rendered compactly regardless of tool type so the
    # synthesizer can see "this call happened, content was evicted".
    if isinstance(result, dict) and result.get("evicted") is True:
        path = result.get("path") or (args.get("path") if isinstance(args, dict) else None)
        note = result.get("note") or "evicted"
        return f"[tool:{tool} path={path}] (evicted — content dropped to stay under synthesizer token cap)\n{note}"

    if tool == "get_file_content":
        if isinstance(result, dict) and result.get("ok"):
            path = result.get("path") or args.get("path")
            size = result.get("size")
            truncated = result.get("truncated")
            content = result.get("content") or ""
            return (
                f"[tool:get_file_content path={path} size={size} "
                f"truncated={bool(truncated)}]\n```\n{content}\n```"
            )
        # Error case
        path = args.get("path")
        err = (result or {}).get("error") if isinstance(result, dict) else None
        return f"[tool:get_file_content path={path}] ERROR\n{err}"

    if tool in ("list_repo_paths", "search_repo_paths"):
        args_str = ", ".join(f"{k}={v!r}" for k, v in args.items() if v)
        paths = (result or {}).get("paths") if isinstance(result, dict) else None
        trunc = (result or {}).get("truncated") if isinstance(result, dict) else False
        count = len(paths or [])
        head = f"[tool:{tool} {args_str}] → {count} paths (truncated={bool(trunc)})"
        if paths:
            body = "\n".join(f"  {p}" for p in paths)
            return f"{head}\n{body}"
        return head

    if tool == "get_repo_ref":
        return f"[tool:get_repo_ref] → {_render_json_compact(result, limit=2000)}"

    if tool == "suggest_important_paths":
        suggested = (
            (result or {}).get("suggestedPaths")
            if isinstance(result, dict)
            else None
        ) or []
        head = f"[tool:suggest_important_paths] → {len(suggested)} suggestions"
        if suggested:
            body = "\n".join(f"  {p}" for p in suggested)
            return f"{head}\n{body}"
        return head

    # Unknown tool: render as JSON.
    return (
        f"[tool:{tool} args={_render_json_compact(args, limit=500)}] → "
        f"{_render_json_compact(result, limit=4000)}"
    )


def _render_integration_entry(entry: TranscriptEntry) -> str:
    """Render a single IntegrationTranscript entry as a Markdown block."""
    if entry.kind == "thought":
        return f"[thought]\n{entry.text or ''}"

    tool = entry.tool or "unknown"
    args = entry.args or {}
    result = entry.result if entry.result is not None else {}

    if isinstance(result, dict) and result.get("evicted") is True:
        purpose = result.get("purpose") or (
            args.get("purpose") if isinstance(args, dict) else None
        )
        exit_code = result.get("exit_code")
        note = result.get("note") or "evicted"
        return (
            f"[tool:{tool}] (evicted — stdout/code/stderr dropped to stay "
            f"under synthesizer token cap)\n"
            f"purpose: {purpose}\nexit_code: {exit_code}\n{note}"
        )

    if tool == "execute_code":
        purpose = args.get("purpose") or (
            result.get("purpose") if isinstance(result, dict) else None
        ) or "(missing purpose)"
        exit_code = entry.exit_code
        if exit_code is None and isinstance(result, dict):
            exit_code = result.get("exit_code")
        explanation = (
            result.get("explanation") if isinstance(result, dict) else None
        ) or ""
        code = (result.get("code") if isinstance(result, dict) else None) or ""
        stdout = (result.get("stdout") if isinstance(result, dict) else None) or ""
        stderr = (result.get("stderr") if isinstance(result, dict) else None) or ""
        error = (result.get("error") if isinstance(result, dict) else None)

        head = f"[tool:execute_code] exit={exit_code}"
        lines = [head, f"purpose: {purpose}"]
        if explanation:
            lines.append(f"explanation: {explanation}")
        if error:
            lines.append(f"error: {error}")
        if code:
            lines.append(f"code:\n```\n{code}\n```")
        if stdout:
            lines.append(f"stdout:\n```\n{stdout}\n```")
        if stderr:
            lines.append(f"stderr:\n```\n{stderr}\n```")
        return "\n".join(lines)

    return (
        f"[tool:{tool} args={_render_json_compact(args, limit=500)}] → "
        f"{_render_json_compact(result, limit=4000)}"
    )


def _entry_rendered_chars(entry: TranscriptEntry, track: str) -> int:
    render = (
        _render_codebase_entry(entry)
        if track == "codebase"
        else _render_integration_entry(entry)
    )
    return len(render)


def _is_high_cost(entry: TranscriptEntry, track: str) -> bool:
    """Returns True if the entry is an eviction candidate by TOOL type.

    High-cost = tool calls whose output dominates byte count:
    - codebase: `get_file_content`
    - integration: `execute_code`

    Thoughts, listing/metadata calls, and short tool results are never
    considered high-cost and are therefore never evicted.

    Note this keys off tool identity, not current size — once an entry
    is stubbed its size is negligible but it's still a tool call of the
    evictable type. The caller tracks which indices have been evicted
    separately via an `already_evicted` set to avoid double-work.
    """
    if entry.kind != "tool_call":
        return False
    if track == "codebase":
        return entry.tool == "get_file_content"
    if track == "integration":
        return entry.tool == "execute_code"
    return False


# ---------------------------------------------------------------------------
# Eviction
# ---------------------------------------------------------------------------


def _evict_for_cap(
    entries: list[TranscriptEntry],
    *,
    track: str,
    soft_token_cap: int,
    stub_formatter,
) -> tuple[list[TranscriptEntry], int]:
    """Return (possibly-rewritten) entries + count of evictions applied.

    Strategy: while the total rendered size exceeds the cap, find the
    oldest high-cost entry that is NOT among the `_PINNED_RECENT_HIGH_COST`
    most recent high-cost entries, and replace it with a stub
    `TranscriptEntry` that preserves the metadata (tool, args, exit_code)
    but drops the bulk fields (content / stdout / code / stderr).

    We never drop entries entirely — the synthesizer still benefits from
    knowing "this call happened, here's what was asked, but the result
    was evicted."

    Returns new list and eviction count. Original `entries` is not
    mutated.
    """
    working: list[TranscriptEntry] = list(entries)
    already_evicted: set[int] = set()

    def _total_chars() -> int:
        return sum(_entry_rendered_chars(e, track) for e in working)

    def _high_cost_indices() -> list[int]:
        return [i for i, e in enumerate(working) if _is_high_cost(e, track)]

    cap_chars = int(soft_token_cap * _CHARS_PER_TOKEN)
    evictions = 0

    total = _total_chars()
    while total > cap_chars:
        hc = _high_cost_indices()
        # Determine which high-cost indices are pinned (the most recent
        # N, by order of appearance in the transcript). Pinning is
        # based on ordinal position among high-cost entries, not on
        # eviction state — so a pinned entry stays pinned even after
        # some older siblings have been stubbed.
        if _PINNED_RECENT_HIGH_COST > 0 and len(hc) > _PINNED_RECENT_HIGH_COST:
            pinned = set(hc[-_PINNED_RECENT_HIGH_COST:])
        else:
            pinned = set(hc)
        # Evictable = high-cost, not pinned, not already evicted.
        evictable = [i for i in hc if i not in pinned and i not in already_evicted]
        if not evictable:
            break
        target = evictable[0]  # oldest first
        original = working[target]
        stub = stub_formatter(original)
        working[target] = stub
        already_evicted.add(target)
        evictions += 1
        new_total = _total_chars()
        if new_total >= total:
            # Safety: if stubbing didn't reduce size (should never
            # happen, but guards against an infinite loop on an unusual
            # stub formatter), stop.
            break
        total = new_total

    return working, evictions


def _codebase_stub(original: TranscriptEntry) -> TranscriptEntry:
    path = (original.args or {}).get("path") if original.args else None
    return replace(
        original,
        result={
            "evicted": True,
            "path": path,
            "note": (
                "Content evicted to stay under synthesizer token cap; "
                "see research_synthesizer_input log for full count."
            ),
        },
    )


def _integration_stub(original: TranscriptEntry) -> TranscriptEntry:
    purpose = (original.args or {}).get("purpose") if original.args else None
    return replace(
        original,
        result={
            "evicted": True,
            "purpose": purpose,
            "exit_code": original.exit_code,
            "note": (
                "stdout/code/stderr evicted to stay under synthesizer token "
                "cap; see research_synthesizer_input log for full count."
            ),
        },
    )


# ---------------------------------------------------------------------------
# Full transcript rendering
# ---------------------------------------------------------------------------


def render_codebase_transcript(
    cb: CodebaseTranscript,
    *,
    soft_token_cap: int = PER_TRACK_SOFT_TOKEN_CAP,
) -> tuple[str, int]:
    """Render a codebase transcript as one Markdown block.

    Returns (rendered_string, evictions_applied).
    """
    entries, evictions = _evict_for_cap(
        cb.entries,
        track="codebase",
        soft_token_cap=soft_token_cap,
        stub_formatter=_codebase_stub,
    )

    header_lines = [
        f"# Codebase investigation — {cb.repo_full_name}",
        "",
        "## Orientation",
        cb.orientation or "(no orientation handoff provided)",
        "",
        "## Repo index",
        f"- defaultBranch: {cb.default_branch or '(unknown)'}",
        f"- indexedPathCount: {cb.path_count}",
        f"- treeTruncated: {cb.tree_truncated}",
    ]
    if cb.tree_warnings:
        header_lines.append("- treeWarnings:")
        for w in cb.tree_warnings:
            header_lines.append(f"  - {w}")
    header_lines.extend(
        [
            f"- stepBudgetExhausted: {cb.step_budget_exhausted}",
            "",
            f"## Exploration log ({len(entries)} entries)",
            "",
        ]
    )

    body = "\n\n".join(_render_codebase_entry(e) for e in entries)
    rendered = "\n".join(header_lines) + "\n" + body
    return rendered, evictions


def render_integration_transcript(
    intg: IntegrationTranscript,
    *,
    soft_token_cap: int = PER_TRACK_SOFT_TOKEN_CAP,
) -> tuple[str, int]:
    """Render an integration transcript as one Markdown block.

    Returns (rendered_string, evictions_applied).
    """
    entries, evictions = _evict_for_cap(
        intg.entries,
        track="integration",
        soft_token_cap=soft_token_cap,
        stub_formatter=_integration_stub,
    )

    header_lines = [
        f"# Integration investigation — {intg.app_url}",
        "",
        "## Orientation",
        intg.orientation or "(no orientation handoff provided)",
        "",
        f"## Integrations covered\n{', '.join(intg.integrations_covered) or '(none)'}",
        "",
        f"## Integrations skipped\n{', '.join(intg.integrations_skipped) or '(none)'}",
        "",
        f"## Sandbox available: {intg.sandbox_available}",
        f"## Step budget exhausted: {intg.step_budget_exhausted}",
        "",
        "## Preflight data",
        "",
    ]
    preflight_sections: list[str] = []
    for t in intg.integrations_covered + intg.integrations_skipped:
        data = intg.preflight_results.get(t)
        if data is None:
            continue
        preflight_sections.append(
            f"### {t.upper()}\n\n```json\n{_render_json_compact(data, limit=200_000)}\n```"
        )
    header = "\n".join(header_lines) + "\n".join(preflight_sections)

    drill_header = f"\n\n## Drill-in log ({len(entries)} entries)\n\n"
    body = "\n\n".join(_render_integration_entry(e) for e in entries)
    rendered = header + drill_header + body
    return rendered, evictions


# ---------------------------------------------------------------------------
# Codebase exploration generator (Call A)
# ---------------------------------------------------------------------------


_CODEBASE_SYSTEM = """You are a software-architecture summarizer for QA planning.

You will be given the full exploration log (file reads, path listings, thought blocks) that an investigator produced while walking a GitHub repository. Your job is to turn that log into a structured description of the application, focused on what a QA human would need to plan tests.

# Output contract

Produce a JSON object matching the provided schema. Field guidance:

- `summary` — 3-5 sentences. What this app IS, its dominant user-facing flow, and its primary value to a user.
- `architecture` — stack + routing model + auth strategy + any notable patterns (monorepo layout, server actions, tRPC, framework-specific conventions).
- `inferredUserFlows` — concrete UI-level user journeys a real user actually performs. Phrase each as a short action: "Sign in with magic link", "Create a new sheet and add columns", "Open billing settings and update card". Derive from routes / pages / form components / mutation surfaces you see in the log. Aim for 8-12 flows.
- `testingImplications` — risks a QA human should prioritize given what was explored: auth surface area, payment flows, forms with complex validation, new or heavily churned modules, accessibility traps.
- `keyPathsExamined` — files actually read by the investigator that informed this description. Pull directly from the transcript's `get_file_content` entries.
- `confidence` — "high" / "medium" / "low". Use "low" if the log shows API errors, the tree was truncated, or the investigation ended on step-budget exhaustion. Use "high" only if the investigator read a meaningful cross-section of the app (routes + auth + a couple of primary-feature files).
- `truncationWarnings` — honest list of gaps. Include any tree warnings from the repo-index metadata, plus anything you noticed was not read (e.g. "payments/ directory never explored").
- `keyEvidence` — 3-6 short verbatim snippets (≤400 chars each) from files in the log that most reveal user-visible behaviour. Prefer lines that reveal behaviour (auth checks, route wiring, form validation, mutation surfaces) over boilerplate. Each entry has `path`, `snippet` (quote the code — do not paraphrase), and a one-sentence `relevance` note.

# Boundaries

- Do NOT produce recommendedFlows, findings, or drillInHighlights — those belong to a separate synthesizer call that has both the codebase AND the integration transcripts.
- Do NOT invent files or snippets. Every `keyEvidence.path` MUST appear in `keyPathsExamined` (and therefore in the transcript). Every snippet MUST be a verbatim excerpt from the transcript.
- Do NOT pad with filler. A small, accurate report is better than a long, speculative one.

If the transcript shows the investigation failed severely (sandbox unavailable, repo not indexed), still emit a best-effort report — set `confidence` to "low", fill `truncationWarnings` with what went wrong, and keep other fields minimal but non-empty."""


async def generate_codebase_exploration(
    cb: CodebaseTranscript,
) -> CodebaseExplorationResult:
    """First synthesis-stage LLM call: codebase transcript -> structured result.

    On success, maps the LLM's structured output directly to the public
    `CodebaseExplorationResult`, applying the defensive 600-char
    snippet cap and filling `toolStepsUsed` from the transcript.

    On failure, returns a low-confidence stub populated from whatever
    transcript metadata is available. Never raises.
    """
    rendered, evictions = render_codebase_transcript(cb)

    chat_log(
        "info",
        "research_codebase_exploration_begin",
        repo=cb.repo_full_name,
        rendered_chars=len(rendered),
        rendered_tokens_est=_estimate_tokens(rendered),
        evictions=evictions,
        entries=len(cb.entries),
    )

    model = get_gemini_pro()
    structured = model.with_structured_output(
        CodebaseExplorationSynthOutput, method="json_schema"
    )

    try:
        output: CodebaseExplorationSynthOutput = await structured.ainvoke(
            [
                {"role": "system", "content": _CODEBASE_SYSTEM},
                {"role": "user", "content": rendered},
            ]
        )
    except Exception as e:
        chat_log(
            "error",
            "research_codebase_exploration_failed",
            repo=cb.repo_full_name,
            err=repr(e),
        )
        return empty_codebase_exploration(
            summary=cb.orientation
            or "Codebase exploration synthesis failed; no summary available.",
            architecture="",
            inferred_user_flows=[],
            testing_implications=(
                "Re-run research or investigate codebase-exploration synthesizer "
                "failure logs."
            ),
            key_paths_examined=_paths_read_from_transcript(cb),
            confidence="low",
            truncation_warnings=[
                f"Codebase exploration synthesis failed: {type(e).__name__}: {e}",
                *cb.tree_warnings,
            ],
            tool_steps_used=cb.tool_steps_used,
        )

    # Apply the defensive snippet cap and project to public type.
    key_evidence = [
        CodebaseEvidenceSnippet(
            path=e.path,
            snippet=(
                e.snippet if len(e.snippet) <= _SNIPPET_MAX
                else e.snippet[:_SNIPPET_MAX] + "…"
            ),
            relevance=e.relevance,
        )
        for e in output.keyEvidence
    ]

    # Merge tree warnings into truncation warnings deterministically
    # (the LLM may or may not remember to include them).
    merged_warnings = list(output.truncationWarnings)
    for w in cb.tree_warnings:
        if w not in merged_warnings:
            merged_warnings.append(w)
    if cb.tree_truncated and not any(
        "tree API" in w for w in merged_warnings
    ):
        merged_warnings.append("GitHub tree API marked truncated=true.")

    result = CodebaseExplorationResult(
        summary=output.summary,
        architecture=output.architecture,
        inferredUserFlows=list(output.inferredUserFlows),
        testingImplications=output.testingImplications,
        keyPathsExamined=list(output.keyPathsExamined),
        confidence=output.confidence,
        truncationWarnings=merged_warnings,
        toolStepsUsed=cb.tool_steps_used,
        keyEvidence=key_evidence,
    )

    chat_log(
        "info",
        "research_codebase_exploration_ok",
        repo=cb.repo_full_name,
        confidence=result.confidence,
        key_evidence_count=len(result.keyEvidence),
        inferred_flow_count=len(result.inferredUserFlows),
        key_paths_count=len(result.keyPathsExamined),
    )
    return result


def _paths_read_from_transcript(cb: CodebaseTranscript) -> list[str]:
    """Best-effort `keyPathsExamined` fallback if synthesis fails."""
    paths: list[str] = []
    seen: set[str] = set()
    for e in cb.entries:
        if e.kind != "tool_call" or e.tool != "get_file_content":
            continue
        p = (e.args or {}).get("path")
        if isinstance(p, str) and p not in seen:
            seen.add(p)
            paths.append(p)
    return paths


# ---------------------------------------------------------------------------
# Flow synthesizer (Call B)
# ---------------------------------------------------------------------------


_FLOW_SYSTEM = """You are the unified QA flow synthesizer for {app_url}.

You will be given TWO investigations:
- A codebase investigation (transcript of repo reads + thoughts) that reveals what this app IS — its stack, routes, auth, and primary user-facing flows.
- An integration investigation (preflight data + drill-in transcript) that reveals what's HAPPENING right now — recent PRs, rage-clicks, Sentry issues, LangSmith failures, and cross-source correlations.

Your job is to synthesize both investigations into a structured research report that a downstream flow-proposer will turn into actual QA tests.

# Output contract

Produce a JSON object matching the provided schema. Pay particular attention to these rules:

## Flow coverage rules (non-negotiable)

Your output has TWO flow lists. They cover complementary categories:

1. `coreFlows` — long-horizon user journeys a signed-in user does in a TYPICAL session, regardless of any recent change. Derive these from the codebase investigation's routes/pages/auth/primary CRUD. Aim for ~60% of your total flows here. Examples of the right kind of thing:
   - "Sign in with email + password → land on dashboard → create a new sheet → add 3 columns → edit a cell → refresh the page → verify the cell persists"
   - "Open account settings → navigate to billing → update payment card → save → return to dashboard → confirm new card is shown on the billing summary"
   - "From the sheets list → open a sheet → share it with a team member by email → sign in as that team member → confirm the sheet is visible in their list and opens cleanly"

2. `riskFocusedFlows` — long-horizon flows ANCHORED to specific recent evidence from the integration transcript (a PR number, a rage-click URL, a Sentry issue ID, a LangSmith failing run). Each MUST cite the anchor in the flow description. Aim for ~40% of total flows. Examples:
   - "Checkout with a saved card on /checkout/* (regression risk after PR #412 touched CheckoutFlow.tsx +214/-38): sign in → add 2 items to cart → proceed to checkout → verify saved card appears → complete purchase → confirm receipt email"
   - "Sheet editor selection handling (ReactEditor.tsx, 482 Sentry events last 7d): sign in → open a sheet with ≥10 rows → select a range → copy-paste → undo → redo → save → reload page → verify state is correct"

## Flow length rules (non-negotiable)

Every flow (in both lists) MUST be a long-horizon, multi-step user journey:

- 4-8 concrete UI interactions minimum, connected by arrows (→).
- Authentication, if required, is the FIRST step of a larger flow. NEVER the whole flow. "Sign in and see the dashboard" is NOT an acceptable flow — that's one step.
- Each flow must exercise at least one meaningful product feature BEYOND navigation + auth (creating something, editing something, submitting a form, completing a workflow, making a payment, sharing with another user, etc.).
- A good flow takes a real user 30-90 seconds to execute, not 5 seconds.
- Include verification steps where natural ("refresh and confirm persistence", "reload page and confirm state", "verify email received").

## Other field guidance

- `summary` — 3-6 sentences synthesizing BOTH investigations. Lead with the biggest risk (e.g. "the largest active QA risk is the sheet editor selection bug surfacing 482 Sentry events..."), then 1-2 further themes. No preamble.
- `findings` — one entry per distinct, actionable signal. Draw from the integration drill-ins, from the repo exploration, or from correlations. Each needs `source`, `category`, `severity`, a `details` field ending with a concrete anchor (commit SHA, PR #, URL, error count, session ID). Populate `rawData` (compact JSON string) whenever numbers, IDs, URLs, or short lists help verify the finding. Valid `source` values include `github`, `github_code`, `posthog`, `sentry`, `langsmith`, `braintrust`.
- `drillInHighlights` — 3-6 one-sentence callouts of SPECIFIC results from the INTEGRATION drill-in log that are worth surfacing to the chat orchestrator verbatim. Each MUST cite a concrete number or anchor pulled from stdout (e.g. "PostHog: 48 $exception events on /w/*/sheets/* in the last 7 days, up from 2 the prior week"). Skip only if the drill-in log produced nothing useful.

# Prioritization inside each flow list

Within `coreFlows` and `riskFocusedFlows`, order by user-visible importance:
1. Flows a user hits every session (dashboard, primary CRUD).
2. Flows that matter for monetization or account integrity (auth, billing, settings).
3. Flows uniquely exercised by secondary features (admin, sharing, integrations).

# Boundaries

- Do NOT emit `codebaseExploration` fields (architecture, keyEvidence, confidence). A separate synthesizer call owns that. Focus your output entirely on the flow-centric fields above.
- Do NOT make up numbers or anchors. Every cited PR #, SHA, issue ID, rage-click count, URL, etc. MUST appear in the transcripts you are given.
- Empty `coreFlows` or empty `riskFocusedFlows` is strongly discouraged. If one investigation is very thin, still produce flows from the other — just label them honestly."""


async def generate_flow_report(
    cb: CodebaseTranscript,
    intg: IntegrationTranscript,
    *,
    app_url: str,
) -> FlowSynthOutput:
    """Second synthesis-stage LLM call: both transcripts -> flow-focused output.

    On failure, returns a minimal `FlowSynthOutput` with orientations
    stitched into `summary`, canned smoke-test core flows, and empty
    findings/highlights. Never raises.
    """
    cb_rendered, cb_evictions = render_codebase_transcript(cb)
    intg_rendered, intg_evictions = render_integration_transcript(intg)

    user_content = f"{cb_rendered}\n\n---\n\n{intg_rendered}\n\n---\n\nProduce the flow-focused research report now."

    chat_log(
        "info",
        "research_flow_synthesis_begin",
        app_url=app_url,
        cb_rendered_chars=len(cb_rendered),
        intg_rendered_chars=len(intg_rendered),
        cb_rendered_tokens_est=_estimate_tokens(cb_rendered),
        intg_rendered_tokens_est=_estimate_tokens(intg_rendered),
        cb_entries_evicted=cb_evictions,
        intg_entries_evicted=intg_evictions,
    )

    model = get_gemini_pro()
    structured = model.with_structured_output(FlowSynthOutput, method="json_schema")

    try:
        output: FlowSynthOutput = await structured.ainvoke(
            [
                {"role": "system", "content": _FLOW_SYSTEM.format(app_url=app_url)},
                {"role": "user", "content": user_content},
            ]
        )
    except Exception as e:
        chat_log(
            "error",
            "research_flow_synthesis_failed",
            app_url=app_url,
            err=repr(e),
        )
        return _flow_fallback(cb, intg, app_url, reason=f"{type(e).__name__}: {e}")

    # Soft validation — log but don't reject.
    core_flows = list(output.coreFlows)
    risk_flows = list(output.riskFocusedFlows)
    all_flows = core_flows + risk_flows
    if all_flows:
        arrow_counts = [f.count("→") for f in all_flows]
        avg_arrows = sum(arrow_counts) / len(arrow_counts)
        min_arrows = min(arrow_counts)
    else:
        avg_arrows = 0.0
        min_arrows = 0

    chat_log(
        "info",
        "research_flow_synthesis_ok",
        app_url=app_url,
        core_flow_count=len(core_flows),
        risk_flow_count=len(risk_flows),
        finding_count=len(output.findings),
        drill_in_count=len(output.drillInHighlights),
        avg_flow_arrow_count=round(avg_arrows, 2),
        min_flow_arrow_count=min_arrows,
    )
    return output


def _flow_fallback(
    cb: CodebaseTranscript,
    intg: IntegrationTranscript,
    app_url: str,
    *,
    reason: str,
) -> FlowSynthOutput:
    """Minimal flow output used when the flow synthesizer fails.

    The chat orchestrator still needs to move forward in this case —
    returning a shaped (if thin) `ResearchReport` beats surfacing a
    synthesis error to the user.
    """
    summary_parts: list[str] = [
        f"Research report is partial — flow synthesis failed ({reason})."
    ]
    if cb.orientation:
        summary_parts.append(f"Codebase investigator said: {cb.orientation}")
    if intg.orientation:
        summary_parts.append(f"Integration investigator said: {intg.orientation}")

    return FlowSynthOutput(
        summary="\n\n".join(summary_parts),
        findings=[],
        coreFlows=[
            # Canned, still-multi-step smoke tests so downstream flow
            # proposer has SOMETHING to work with.
            f"Homepage load → primary navigation → open a main feature → "
            f"interact with it → verify response → {app_url} — smoke test of "
            "core app surface.",
            "Authenticate → land on dashboard → exercise a primary create/edit "
            "action → save → reload → verify persistence.",
        ],
        riskFocusedFlows=[],
        drillInHighlights=[],
    )


# ---------------------------------------------------------------------------
# Convenience for orchestrator: bundle both synthesis calls' outputs
# ---------------------------------------------------------------------------


def flow_output_to_findings(output: FlowSynthOutput) -> list[ResearchFinding]:
    """Project `_SynthFinding` pydantic objects to public `ResearchFinding`."""
    return [
        ResearchFinding(
            source=f.source,
            category=f.category,
            details=f.details,
            severity=f.severity,
            rawData=f.rawData,
        )
        for f in output.findings
    ]


def flatten_flows(output: FlowSynthOutput) -> list[str]:
    """Combine core + risk flows into a single list for ResearchReport.

    Order: core flows first, then risk-focused. This preserves the
    "user-visible importance first" bias while surfacing risk flows
    below — downstream flow proposer and UI consumers see both without
    having to know the category split.
    """
    return list(output.coreFlows) + list(output.riskFocusedFlows)
