"""Integration research sub-agent.

Produces an `IntegrationTranscript` for a project by combining two
phases:

    1. **Preflight** — fixed httpx calls per integration that gather the
       obvious first-layer signal (recent PRs, top rage-click URLs,
       top unresolved issues, etc.).

    2. **Research loop (ReAct over Modal Sandbox).** A Claude Opus 4.7
       orchestrator iteratively calls one tool, `execute_code(purpose)`,
       with a natural-language goal. The tool delegates CODE GENERATION
       to a separate Claude Opus 4.7 code writer (see `code_writer.py`),
       executes the resulting Python inside a gVisor-isolated Modal
       Sandbox with creds preloaded as env vars, and returns
       `{exit_code, stdout, stderr, explanation}`. The orchestrator
       decides what to ask next based on everything it has seen so far
       — including correlating signals ACROSS integrations (e.g. a
       rage-clicked URL from call #2 matching a GitHub PR from call
       #4). Loops up to `RESEARCH_INTEGRATION_MAX_STEPS` (default 20)
       times.

       Both the orchestrator and the code writer run on Opus 4.7 but
       in different roles: the orchestrator decides WHAT to investigate
       (cross-provider reasoning over a long-running message log) and
       the code writer generates the focused per-call Python script.
       Keeping them on the same model family produces consistent
       reasoning style across the chain; splitting the role keeps each
       prompt tight (see `code_writer.py` for that rationale).

The agent no longer runs its own synthesis pass. Instead it returns the
full investigation transcript (preflight + all tool calls + every
orchestrator thought) for the unified synthesis stage
(`runner.research.synthesizer.generate_flow_report`) to consume.

## Why code writing is split out of the orchestrator

The orchestrator's job is deciding WHAT to investigate — scanning
signals, correlating across providers, choosing the next question.
Asking the same LLM call to also WRITE the Python was bad because
each prior exec appends (AIMessage with full code) + (ToolMessage
with stdout) — over 20 steps that buries the signal in raw code the
orchestrator doesn't need for routing. Splitting the two roles keeps
each prompt tight and lets us evolve them independently.

So `execute_code(purpose="...")` takes only a natural-language goal,
and the tool body uses the code writer to produce the script before
running it. See `runner.research.code_writer` for the code generator.

## Per-exec field sizing: orchestrator-visible vs transcript-visible

Each `execute_code` invocation produces three raw artifacts: the
generated `code`, and the exec's `stdout` / `stderr`. These land in
two distinct places with different size budgets:

- **Orchestrator-visible** (returned from the tool as a JSON string
  that becomes a ToolMessage): this lands in every subsequent turn's
  context. Kept tight (`stdout[:4000]`, `stderr[:1000]`) so a 20-step
  loop's context doesn't balloon.
- **Transcript-visible** (the `TranscriptEntry.result` dict): this is
  what the final synthesizer reads, exactly once. Kept generous
  (`stdout[:60_000]`, `stderr[:4000]`, `code` un-truncated) because the
  synthesizer has a 1M context window and the signal that matters for
  flow generation often lives in the long tail of a stdout payload.

## Error handling

Every layer has a graceful-degradation path:

- Credential decryption fails -> integration is dropped from the run,
  ends up in `integrations_skipped`.
- A single preflight fails -> that integration shows up as
  `success: False` in the preflight block but the run continues.
- The sandbox itself fails to create (Modal outage, bad image) -> we
  log, mark `sandbox_available=False`, and return a transcript with
  just the preflight data. The synthesizer handles it.
- A single exec fails -> stderr surfaced back to the orchestrator as
  a ToolMessage; the code writer also gets to see the failure on its
  next call for self-correction.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from runner.chat.logging import chat_log
from runner.chat.models import get_claude_opus_integration_orchestrator
from runner.encryption import decrypt
from runner.research.code_writer import (
    CodeWriterOutput,
    PreviousExec,
    write_research_code,
)
from runner.research.docs import get_integration_docs_bundle
from runner.research.github_client import get_installation_token
from runner.research.github_repo_explorer import parse_repo_full_name
from runner.research.prompts_common import SYSTEM_PURPOSE_OVERVIEW
from runner.research.preflight import (
    preflight_braintrust,
    preflight_github,
    preflight_langsmith,
    preflight_posthog,
    preflight_sentry,
)
from runner.research.sandbox import (
    ExecResult,
    IntegrationEnv,
    create_research_sandbox,
    env_key_int,
    execute_in_sandbox,
    teardown_sandbox,
)
from runner.research.types import (
    IntegrationTranscript,
    TranscriptEntry,
)


# ---------------------------------------------------------------------------
# Per-call sizing
# ---------------------------------------------------------------------------
#
# Two sets of limits. Keep them distinct from each other on purpose.

# What the orchestrator sees on every subsequent turn. Tight — compounds.
_ORCH_STDOUT_CAP = 4_000
_ORCH_STDERR_CAP = 1_000

# What the synthesizer sees once. Generous — the synthesizer LLM
# (`generate_codebase_exploration` on Gemini, `generate_flow_report` on
# Opus 4.7) reads the full transcript via `render_*_transcript` which
# applies its own per-track soft caps to keep total input under each
# model's input ceiling.
_TRANSCRIPT_STDOUT_CAP = 60_000
_TRANSCRIPT_STDERR_CAP = 4_000
# `code` is un-truncated in the transcript; kept small by construction
# (the code writer emits one focused script per call, ~0.5-3K typical).

# Code-writer self-correction context. Unchanged. Stays tight because
# the code writer only needs enough stderr to diagnose the prior
# failure; the full stderr is preserved in the transcript anyway.
_CODE_WRITER_STDERR_HEAD = 1_000


# ---------------------------------------------------------------------------
# Preflight dispatch
# ---------------------------------------------------------------------------


async def _error_task(message: str) -> dict[str, Any]:
    return {"success": False, "error": message}


async def _gh_preflight(installation_id: int, owner: str, repo: str) -> dict[str, Any]:
    token = await get_installation_token(installation_id)
    return await preflight_github(
        installation_token=token, owner=owner, repo=repo
    )


async def _run_preflights(
    app_url: str,
    integration_configs: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Fire all integration preflights in parallel."""
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


# ---------------------------------------------------------------------------
# Sandbox env construction
# ---------------------------------------------------------------------------


async def _build_sandbox_env(
    integration_configs: dict[str, dict[str, Any]],
) -> IntegrationEnv:
    """Build the env var set that gets injected into the research sandbox.

    The contract with the LLM is documented in the system prompt: every
    integration has a predictable env var naming scheme so the code
    writer can produce scripts like `os.environ["POSTHOG_API_KEY"]`
    without having to be told the value up-front.

    Public vs. secret split matters:
    - `public` vars (hostnames, project IDs) go via plain env dict.
    - `secret` vars (API keys, auth tokens) go via `modal.Secret.from_dict`
      so Modal itself doesn't log them in build/run traces.
    """
    public: dict[str, str] = {}
    secret: dict[str, str] = {}

    for t, cfg in integration_configs.items():
        if t == "github":
            # GitHub is special: we mint a short-lived installation token
            # at build time rather than passing raw App credentials to
            # the sandbox.
            installation_id = cfg.get("installation_id")
            repo_full_name = cfg.get("repo_full_name") or ""
            if installation_id and repo_full_name:
                try:
                    token = await get_installation_token(int(installation_id))
                    secret["GITHUB_INSTALLATION_TOKEN"] = token
                    public["GITHUB_REPO"] = repo_full_name
                except Exception as e:
                    chat_log(
                        "warn",
                        "research_sandbox_env_github_token_failed",
                        err=repr(e),
                    )
        elif t == "posthog":
            api_key = cfg.get("api_key")
            project_id = cfg.get("posthog_project_id")
            host = (cfg.get("api_host") or "https://us.posthog.com").rstrip("/")
            if api_key and project_id:
                secret["POSTHOG_API_KEY"] = api_key
                public["POSTHOG_HOST"] = host
                public["POSTHOG_PROJECT_ID"] = str(project_id)
        elif t == "sentry":
            token = cfg.get("auth_token")
            org = cfg.get("organization_slug")
            proj = cfg.get("project_slug")
            if token and org and proj:
                secret["SENTRY_AUTH_TOKEN"] = token
                public["SENTRY_ORG_SLUG"] = str(org)
                public["SENTRY_PROJECT_SLUG"] = str(proj)
        elif t == "langsmith":
            api_key = cfg.get("api_key")
            if api_key:
                secret["LANGSMITH_API_KEY"] = api_key
                project_name = cfg.get("project_name")
                if project_name:
                    public["LANGSMITH_PROJECT_NAME"] = str(project_name)
        elif t == "braintrust":
            api_key = cfg.get("api_key")
            if api_key:
                secret["BRAINTRUST_API_KEY"] = api_key

    return IntegrationEnv(public=public, secret=secret)


# ---------------------------------------------------------------------------
# Orchestrator system prompt
# ---------------------------------------------------------------------------


_ALL_KNOWN_PROVIDERS = ["github", "posthog", "sentry", "langsmith", "braintrust"]


def _build_orchestrator_system_prompt(
    app_url: str,
    integrations_covered: list[str],
) -> str:
    """System prompt for the Claude Opus 4.7 orchestrator.

    The orchestrator does NOT write Python. It issues natural-language
    research goals via `execute_code(purpose=...)`; a separate code
    writer turns each goal into a script and runs it.

    Emphasis on two things:
    1. **Cross-source ReAct.** The orchestrator can keep calling the
       tool across different integrations in any order, including
       correlating findings.
    2. **Writing GOALS, not CODE.** The tool contract is purpose-based;
       any code-level details belong in the purpose as natural-language
       intent, not Python.

    Unlike the pre-revamp prompt this one does NOT ask the orchestrator
    to produce structured output at the end — its last turn is simply
    a natural-language summary of what it learned. That summary becomes
    the transcript's `orientation` blurb for the downstream synthesizer.

    The "Hard rules" + repeated covered-list framing exists so the
    orchestrator stops issuing `purpose` strings naming providers that
    aren't actually configured for this project (PostHog, Sentry, etc.
    when only GitHub is connected). The model needs to see the constraint
    both at policy-imprint position (top of prompt) and at recency-bias
    position (just before its decision turn) for it to land reliably.
    """
    covered_list = ", ".join(integrations_covered) if integrations_covered else "(none)"
    uncovered = [p for p in _ALL_KNOWN_PROVIDERS if p not in integrations_covered]
    uncovered_list = ", ".join(uncovered) if uncovered else "(none)"
    return f"""{SYSTEM_PURPOSE_OVERVIEW}

# Your role in the pipeline

You are the integration research orchestrator. The customer's deployed app is at {app_url}. You decide WHAT to investigate across their connected observability/source integrations so that, downstream, our system can choose which long-horizon UI flows to bug-bash with our autonomous browser agent.

The pipeline you sit inside:

1. A codebase exploration agent (separate, runs in parallel to you) is mapping the app's architecture and the long-horizon UI journeys real users walk.
2. You investigate the connected integrations to surface concrete, anchored evidence that some of those user-facing journeys are at risk RIGHT NOW (a recent PR churned that page, real users are rage-clicking it, Sentry is recording errors there, an AI feature behind it is failing in LangSmith).
3. A unified flow-synthesis LLM combines your transcript with the codebase agent's transcript into a research report listing CORE long-horizon UI flow ideas (from the codebase) and RISK-ANCHORED long-horizon UI flow ideas (anchored to YOUR evidence).
4. A flow-proposal LLM converts the strongest of those into approvable, executable flow cards that the autonomous browser agent walks against the live app.

So your output is NOT "a generic activity report on the integrations." It is "concrete, anchored, USER-FACING risk evidence the downstream synthesizer can convert into long-horizon UI flow ideas the agent should bug-bash." Every drill-in you do should answer some version of: "is there a recent change or live failure in the product that makes a real-user UI journey worth re-walking right now?"

# Hard rules (non-negotiable)

1. **The ONLY providers you may investigate are listed under "Connected integrations" below.** For this project, the connected providers are: **{covered_list}**.
2. **Do NOT issue purposes that name, target, or require credentials from any other provider.** The following providers are NOT connected for this project and are off-limits: **{uncovered_list}**. Their environment variables (e.g. `POSTHOG_API_KEY`, `SENTRY_AUTH_TOKEN`, `LANGSMITH_API_KEY`, `BRAINTRUST_API_KEY`) are NOT set in the sandbox; the code writer cannot fabricate them, and any `purpose` that targets one of these providers will fail with a `KeyError` or 4xx and waste a step.
3. **If you find yourself wanting to drill into an off-limits provider, do not.** Either:
   a. Drill into a connected provider in a way that surfaces equivalent signal (e.g. if PostHog isn't connected but you want user-pain evidence, look at GitHub issue comments, PR review comments, or commit messages mentioning user reports), or
   b. Stop and emit your handoff summary, noting in the summary that the off-limits provider's signal is a known gap so the synthesizer doesn't invent flows about it.
4. **Every `purpose` string you emit must be answerable using ONLY the connected providers' APIs.** If your purpose mentions "PostHog rage clicks", "Sentry exceptions", "LangSmith errors", "Braintrust experiments", etc., and the corresponding provider isn't in the connected list above, that purpose is INVALID. Rewrite it before you emit it, or skip it.
5. Before each `execute_code` call, take one quiet moment to re-read the purpose you are about to send. If it names or implies any provider not in the connected list, rewrite it to use only connected providers, or do not send it.

# Tool

You have one tool:

    execute_code(purpose: str) -> {{exit_code, stdout, stderr, explanation}}

Pass a clear, natural-language research goal as `purpose`. A specialized code-writer model translates your purpose into a focused Python script and runs it inside an isolated sandbox against the connected integration APIs, with credentials already preloaded as environment variables. You will see:

- `exit_code` — 0 on success, non-zero on failure (HTTP 4xx/5xx wrapped as JSON errors still count as success here; actual Python exceptions are non-zero).
- `stdout` — the script's printed JSON output (truncated to ~4KB for your context; the full stdout is preserved for the downstream synthesizer).
- `stderr` — any Python exception traceback or error stream (truncated).
- `explanation` — one-sentence note from the code writer describing what the script did (useful for verifying the code writer understood your goal).

# How to write good `purpose` strings

A good `purpose` is grounded in user-visible behaviour. Bias every drill-in toward one of these question shapes:

- "Which user-facing surface (page, route, feature) just changed heavily, and on what timeline?"
- "Which user-facing surface (page, route, feature) is producing real-user pain right now (errors, rage clicks, failing AI runs)?"
- "Does a recent code change correlate with a spike in user pain on the surface it touched?" (Cross-source — these are your highest-signal calls.)

BAD (too vague): "Investigate GitHub"
BAD (writing code): "Call GET /repos/owner/repo/pulls/206/files and print additions per file"
BAD (not user-facing): "Count the total number of commits in the repo this month"
GOOD: "List the files changed in PR #206, grouped by top-level directory and by user-facing route prefix (app/, pages/, src/app/), with per-file additions/deletions. Return the top 10 largest-changed user-facing files so the downstream synthesizer can tell which UI surfaces the PR likely affects."
GOOD: "Top 10 PostHog rage-click URLs over the last 14 days with event counts, plus the user-flow each URL most likely belongs to (e.g. /checkout/* -> checkout flow). The downstream synthesizer will use these to propose risk-anchored UI flows for the browser agent."

A good purpose names:
- The provider (GitHub / PostHog / Sentry / LangSmith / Braintrust).
- The specific entity or range (PR #206, last 14 days of $exception events, Sentry issue with the highest count).
- The exact output shape you want, framed in terms a downstream UI-flow proposer can use ("return file counts grouped by directory and by user-facing route prefix", "return the top 5 rage-click URLs with counts and inferred user flow", "join with timestamps so we can correlate with a PR merge date").

# Cross-source investigation (do this!)

You have memory of every prior tool call in this conversation. Use it. The highest-signal investigations correlate signals across integrations to point at a specific real-user UI journey:

- "GitHub PR #206 touched app/checkout/* on Mar 14. Query PostHog for the count of $exception events on URLs matching /checkout/* in the 7 days AFTER Mar 14 vs the 7 days before — we want to know if real users walking the checkout flow are now hitting more errors after this PR shipped."
- "Sentry issue SENTRY-1234 points at a TypeError in ReactEditor.tsx. Query GitHub for the last 5 commits that touched files matching ReactEditor*, and return commit sha + message + author so we can tell if a recent change introduced this user-facing crash."
- "PostHog rage-click on /w/*/sheets/* is #1 at 290 events. Query LangSmith for error runs whose inputs reference sheet IDs or contain 'sheet', last 7 days, to see if an AI feature inside the sheets UI is also failing — that would let us anchor a single risk-anchored UI flow that walks the sheet AND triggers the AI feature."

An orchestrator that correlates across providers surfaces much stronger evidence — the kind that turns into a single high-priority risk-anchored UI flow — than one that only drills into one source at a time.

# Loop discipline

- Each tool call is sequential. Wait for the previous result, read stdout, decide the next question.
- Stop calling tools when your next call wouldn't change which long-horizon UI flows the downstream synthesizer would propose. Don't pad.
- Step budget is ~20 total. Spend it on surfacing NEW anchored, user-facing evidence, not re-verifying preflight numbers.
- Narrate your plan in short text blocks between tool calls when it helps — those thoughts are preserved verbatim for the downstream synthesizer, and explaining "I want to drill into PR #206 because preflight says it touched checkout, which is a core flow" is high-signal context.

# What preflight already gave you

The user message below contains each integration's preflight result (recent commits/PRs, top rage-clicks, top unresolved Sentry issues, etc.) as JSON. Read it first; don't waste calls re-fetching what it already has. Use preflight to pick which user-facing surfaces are worth drilling into; use `execute_code` to drill in.

# How to finish

When you have enough evidence-backed findings to anchor risk-focused UI flows, stop calling tools and emit a final message with no tool calls. In that final message, write a 3-5 sentence summary of the biggest user-facing risks you found (which page/journey, which PR or error or rage-click, with concrete numbers/anchors). Connect each risk back to a real-user UI journey wherever you can — the downstream synthesizer's job is much easier when your handoff is already framed in user-flow terms. That summary becomes your handoff to the synthesizer. Do NOT try to produce a structured report — that's the synthesizer's job. Just a clear, anchored narrative paragraph.

# Connected integrations (READ THIS BEFORE EVERY `execute_code` CALL)

For this project, the ONLY connected providers are: **{covered_list}**.

Off-limits (do NOT investigate these — their credentials are not configured): **{uncovered_list}**.

Before sending any `execute_code(purpose=...)` call, re-read the purpose. If it names or implies any provider in the off-limits list above, rewrite it to use only connected providers, or stop and emit your handoff summary instead. A purpose that targets an off-limits provider WILL fail with a missing-env-var error and waste your step budget; the synthesizer cannot use the resulting empty stdout."""


# ---------------------------------------------------------------------------
# Config resolution (decrypt + flatten)
# ---------------------------------------------------------------------------


def _resolve_configs(active_integrations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Decrypt and flatten active integration configs into `{type -> plain dict}`."""
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


def _truncate(s: str, limit: int) -> str:
    """Truncate a string with a visible marker."""
    if s is None:
        return ""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n\n[...truncated {len(s) - limit} more chars]"


# ---------------------------------------------------------------------------
# Extract text blocks from AIMessage (for orientation + thought capture)
# ---------------------------------------------------------------------------


def _extract_text_blocks(response: AIMessage) -> list[str]:
    content = response.content
    out: list[str] = []
    if isinstance(content, str):
        if content.strip():
            out.append(content.strip())
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str) and t.strip():
                    out.append(t.strip())
    return out


# ---------------------------------------------------------------------------
# Main research loop
# ---------------------------------------------------------------------------


async def _run_research_loop(
    app_url: str,
    integrations_covered: list[str],
    preflight_results: dict[str, dict[str, Any]],
    env: IntegrationEnv,
) -> tuple[list[TranscriptEntry], str, bool, bool]:
    """ReAct loop where the orchestrator issues natural-language goals.

    Returns (entries, orientation, step_budget_exhausted, sandbox_available).

    `entries` is the ordered transcript — each tool call produces a
    `kind="tool_call"` entry with the full un-truncated-at-this-stage
    `{purpose, explanation, code, stdout, stderr}` in `result`, and each
    orchestrator text block produces a `kind="thought"` entry.

    Cross-source ReAct works here because every prior tool call's
    result is appended to the orchestrator's `messages`, so turn N sees
    turns 1..N-1 in context.
    """
    max_steps = env_key_int("RESEARCH_INTEGRATION_MAX_STEPS", 20)

    import modal as _modal

    sb: _modal.Sandbox | None = None
    entries: list[TranscriptEntry] = []
    orientation = ""

    try:
        sb = await create_research_sandbox(env)
    except Exception as e:
        chat_log(
            "warn",
            "research_sandbox_create_failed",
            err=repr(e),
        )
        entries.append(
            TranscriptEntry(
                kind="thought",
                text=(
                    f"[sandbox unavailable: {type(e).__name__}: {e}] "
                    "Skipping drill-in loop; synthesizer will fall back to "
                    "preflight-only reasoning."
                ),
            )
        )
        return entries, (
            "Sandbox was unavailable; no drill-in evidence was gathered. "
            "Synthesize from preflight alone."
        ), False, False

    # Pre-compute the provider docs block + env description once so the
    # code writer can re-use them on every call.
    docs_block = "\n\n---\n\n".join(
        f"## {t.upper()} API docs\n\n{doc}"
        for t, doc in get_integration_docs_bundle(integrations_covered).items()
    )
    env_description = env.describe()

    # Tracks the immediately-previous exec so the code writer can
    # self-correct on transient failures. One call's history only.
    previous_exec: PreviousExec | None = None

    @tool
    async def execute_code(purpose: str) -> str:
        """Execute a research investigation step against the connected integrations.

        Pass a natural-language research goal as `purpose`. A specialized
        code writer will turn it into Python that runs inside an isolated
        Modal Sandbox with credentials preloaded as environment variables,
        then return {exit_code, stdout, stderr, explanation}.

        Args:
            purpose: A specific, actionable research goal. Name the
                provider (GitHub / PostHog / Sentry / LangSmith / Braintrust),
                the target entity or time window, and the desired output
                shape. E.g. 'List files changed in GitHub PR #206,
                grouped by top-level directory, with additions/deletions.'
        """
        nonlocal previous_exec

        # Phase A: code writer produces the Python.
        code_output: CodeWriterOutput = await write_research_code(
            purpose=purpose,
            docs_block=docs_block,
            env_description=env_description,
            previous_exec=previous_exec,
        )

        # Phase B: run the code in the sandbox.
        assert sb is not None
        result: ExecResult = await execute_in_sandbox(sb, code_output.code)

        # Remember for the code writer's next call.
        previous_exec = PreviousExec(
            purpose=purpose,
            exit_code=result.exit_code,
            stderr_head=_truncate(result.stderr, _CODE_WRITER_STDERR_HEAD),
        )

        # Record a transcript entry. This is what the SYNTHESIZER will
        # see — generous caps, code un-truncated.
        transcript_result = {
            "purpose": purpose,
            "explanation": code_output.explanation,
            "exit_code": result.exit_code,
            "code": code_output.code,
            "stdout": _truncate(result.stdout, _TRANSCRIPT_STDOUT_CAP),
            "stderr": _truncate(result.stderr, _TRANSCRIPT_STDERR_CAP),
        }
        entries.append(
            TranscriptEntry(
                kind="tool_call",
                tool="execute_code",
                args={"purpose": purpose},
                result=transcript_result,
                exit_code=result.exit_code,
            )
        )

        chat_log(
            "info",
            "research_execute_code",
            purpose=purpose[:200],
            exit_code=result.exit_code,
            code_length=len(code_output.code),
            stdout_length=len(result.stdout),
            stderr_length=len(result.stderr),
            explanation=code_output.explanation,
        )

        # What the ORCHESTRATOR sees. Tight — compounds over 20 turns.
        return json.dumps(
            {
                "purpose": purpose,
                "explanation": code_output.explanation,
                "exit_code": result.exit_code,
                "stdout": _truncate(result.stdout, _ORCH_STDOUT_CAP),
                "stderr": _truncate(result.stderr, _ORCH_STDERR_CAP),
            },
            default=str,
        )

    step_budget_exhausted = False
    try:
        model = get_claude_opus_integration_orchestrator().bind_tools([execute_code])

        preflight_block = "\n\n".join(
            f"## {t.upper()} preflight\n\n```json\n{json.dumps(preflight_results[t], indent=2, default=str)}\n```"
            for t in integrations_covered
        )

        uncovered_providers = [
            p for p in _ALL_KNOWN_PROVIDERS if p not in integrations_covered
        ]
        uncovered_reminder = (
            f"\n\nReminder: only investigate the connected providers "
            f"({', '.join(integrations_covered) or 'none'}). Do NOT issue "
            f"purposes that target {', '.join(uncovered_providers)} — those "
            "providers are not connected for this project and their credentials "
            "are not in the sandbox. A purpose targeting any of them will fail "
            "with a missing-env-var error."
        ) if uncovered_providers else ""

        messages: list = [
            SystemMessage(
                content=_build_orchestrator_system_prompt(
                    app_url=app_url,
                    integrations_covered=integrations_covered,
                )
            ),
            HumanMessage(
                content=(
                    f"Investigate {', '.join(integrations_covered)} for evidence "
                    f"that can anchor long-horizon UI flow proposals on {app_url}. "
                    "Read the preflight data below, pick the most promising signals "
                    "of recent change or live user pain on user-facing surfaces, and "
                    "call `execute_code` with clear research goals — including "
                    "cross-provider correlations where they reveal more than "
                    "single-source drill-ins. Stop when you have enough "
                    "evidence-backed, user-facing findings to anchor risk-focused "
                    "UI flows for our autonomous browser agent, and emit a 3-5 "
                    "sentence handoff summary."
                    f"{uncovered_reminder}\n\n"
                    "# Preflight data\n\n"
                    f"{preflight_block}"
                )
            ),
        ]

        for step in range(max_steps):
            response: AIMessage = await model.ainvoke(messages)
            messages.append(response)

            text_blocks = _extract_text_blocks(response)
            for text in text_blocks:
                entries.append(TranscriptEntry(kind="thought", text=text))

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:
                orientation = "\n\n".join(text_blocks)
                chat_log(
                    "info",
                    "research_loop_done",
                    step=step,
                    total_execs=sum(1 for e in entries if e.kind == "tool_call"),
                    orientation_chars=len(orientation),
                )
                break

            for tc in tool_calls:
                name = tc.get("name")
                args = tc.get("args") or {}
                if name != "execute_code":
                    tool_result = json.dumps(
                        {"error": f"Unknown tool '{name}'. Only execute_code is available."}
                    )
                    entries.append(
                        TranscriptEntry(
                            kind="tool_call",
                            tool=str(name),
                            args=dict(args) if isinstance(args, dict) else {"raw": args},
                            result={"error": f"Unknown tool '{name}'."},
                        )
                    )
                elif not str(args.get("purpose") or "").strip():
                    tool_result = json.dumps(
                        {
                            "error": (
                                "execute_code requires a non-empty "
                                "`purpose` string describing the research goal."
                            )
                        }
                    )
                    entries.append(
                        TranscriptEntry(
                            kind="tool_call",
                            tool="execute_code",
                            args=dict(args) if isinstance(args, dict) else {},
                            result={"error": "empty purpose"},
                        )
                    )
                else:
                    try:
                        tool_result = await execute_code.ainvoke(args)
                    except Exception as e:
                        chat_log(
                            "error",
                            "research_execute_code_uncaught",
                            err=repr(e),
                            purpose=str(args.get("purpose") or "")[:200],
                        )
                        tool_result = json.dumps(
                            {
                                "purpose": args.get("purpose"),
                                "error": f"{type(e).__name__}: {e}",
                            }
                        )
                        entries.append(
                            TranscriptEntry(
                                kind="tool_call",
                                tool="execute_code",
                                args={"purpose": args.get("purpose")},
                                result={"error": f"{type(e).__name__}: {e}"},
                                exit_code=1,
                            )
                        )
                messages.append(
                    ToolMessage(
                        content=tool_result,
                        tool_call_id=tc["id"],
                        name="execute_code",
                    )
                )
        else:
            step_budget_exhausted = True
            chat_log(
                "warn",
                "research_loop_step_budget_exhausted",
                max_steps=max_steps,
                total_execs=sum(1 for e in entries if e.kind == "tool_call"),
            )

        return entries, orientation, step_budget_exhausted, True

    finally:
        await teardown_sandbox(sb)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


async def run_integration_research_transcript(
    *,
    app_url: str,
    active_integrations: list[dict[str, Any]],
) -> IntegrationTranscript:
    """End-to-end integration research pass.

    Returns an `IntegrationTranscript` carrying preflight data, the full
    drill-in log, and a natural-language orientation blurb. Never
    raises — callers always get a shaped transcript (possibly with
    error text in `orientation` if everything failed).

    Orchestrates two phases (preflight -> sandbox drill-in) and the
    graceful-degradation paths between them. The synthesis step lives
    in `runner.research.synthesizer.generate_flow_report`.
    """
    if not active_integrations:
        return IntegrationTranscript(
            app_url=app_url,
            integrations_covered=[],
            integrations_skipped=[],
            preflight_results={},
            orientation=(
                "No integrations are connected. Synthesizer should produce "
                "flows based on the codebase track and general best practices."
            ),
            entries=[],
            step_budget_exhausted=False,
            sandbox_available=False,
        )

    resolved = _resolve_configs(active_integrations)
    if not resolved:
        return IntegrationTranscript(
            app_url=app_url,
            integrations_covered=[],
            integrations_skipped=[
                str(r.get("type"))
                for r in active_integrations
                if isinstance(r.get("type"), str)
            ],
            preflight_results={},
            orientation=(
                "Integrations are connected but credentials could not be "
                "resolved. Synthesizer should rely on the codebase track."
            ),
            entries=[],
            step_budget_exhausted=False,
            sandbox_available=False,
        )

    # Phase 1: preflight.
    preflight_results = await _run_preflights(app_url, resolved)

    integrations_covered: list[str] = []
    integrations_skipped: list[str] = []
    for t, result in preflight_results.items():
        if result.get("success"):
            integrations_covered.append(t)
        else:
            integrations_skipped.append(t)

    if not integrations_covered:
        return IntegrationTranscript(
            app_url=app_url,
            integrations_covered=[],
            integrations_skipped=integrations_skipped,
            preflight_results=preflight_results,
            orientation=(
                "All integration preflights failed. Synthesizer should rely "
                "on the codebase track."
            ),
            entries=[],
            step_budget_exhausted=False,
            sandbox_available=False,
        )

    # Phase 2: sandbox-backed research loop.
    env = await _build_sandbox_env(resolved)
    try:
        entries, orientation, step_budget_exhausted, sandbox_available = (
            await _run_research_loop(
                app_url=app_url,
                integrations_covered=integrations_covered,
                preflight_results=preflight_results,
                env=env,
            )
        )
    except Exception as e:
        chat_log("error", "research_loop_uncaught", err=repr(e))
        entries = [
            TranscriptEntry(
                kind="thought",
                text=f"[research loop failed: {type(e).__name__}: {e}]",
            )
        ]
        orientation = f"Research loop failed: {type(e).__name__}: {e}"
        step_budget_exhausted = False
        sandbox_available = False

    # Collect pre-truncation stdout stats for observability.
    exec_entries = [
        e for e in entries if e.kind == "tool_call" and e.tool == "execute_code"
    ]
    stdout_lens = [
        len(str((e.result or {}).get("stdout") or ""))
        for e in exec_entries
        if isinstance(e.result, dict)
    ]
    max_stdout = max(stdout_lens) if stdout_lens else 0
    # Rough p95 without numpy — sort + index at 95th percentile.
    p95_stdout = 0
    if stdout_lens:
        sorted_lens = sorted(stdout_lens)
        idx = min(
            len(sorted_lens) - 1,
            max(0, int(round(0.95 * (len(sorted_lens) - 1)))),
        )
        p95_stdout = sorted_lens[idx]

    chat_log(
        "info",
        "research_integration_transcript_built",
        app_url=app_url,
        integrations_covered=integrations_covered,
        integrations_skipped=integrations_skipped,
        entries_count=len(entries),
        exec_count=len(exec_entries),
        thoughts=sum(1 for e in entries if e.kind == "thought"),
        max_stdout_chars=max_stdout,
        p95_stdout_chars=p95_stdout,
        step_budget_exhausted=step_budget_exhausted,
        sandbox_available=sandbox_available,
        orientation_chars=len(orientation),
    )

    return IntegrationTranscript(
        app_url=app_url,
        integrations_covered=integrations_covered,
        integrations_skipped=integrations_skipped,
        preflight_results=preflight_results,
        orientation=orientation,
        entries=entries,
        step_budget_exhausted=step_budget_exhausted,
        sandbox_available=sandbox_available,
    )
