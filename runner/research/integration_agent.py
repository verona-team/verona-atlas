"""Integration research sub-agent.

Produces a structured `IntegrationResearchReport` for a project by
combining three passes:

    1. **Preflight** — fixed httpx calls per integration that gather the
       obvious first-layer signal (recent PRs, top rage-click URLs,
       top unresolved issues, etc.).

    2. **Research loop (ReAct over Modal Sandbox).** A Gemini 3.1 Pro
       orchestrator iteratively calls one tool, `execute_code(purpose)`,
       with a natural-language goal. The tool delegates CODE GENERATION
       to a separate Gemini 3.1 Pro code writer (see `code_writer.py`),
       executes the resulting Python inside a gVisor-isolated Modal
       Sandbox with creds preloaded as env vars, and returns
       `{exit_code, stdout, stderr, explanation}`. The orchestrator
       decides what to ask next based on everything it has seen so far
       — including correlating signals ACROSS integrations (e.g. a
       rage-clicked URL from call #2 matching a GitHub PR from call
       #4). Loops up to `RESEARCH_INTEGRATION_MAX_STEPS` (default 20)
       times.

    3. **Synthesis** — a single Gemini 3.1 Pro structured-output call
       that turns preflight data + research notes (purpose + result for
       each call) into the final `IntegrationResearchReport`.

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

## Error handling

Every layer has a graceful-degradation path:

- Credential decryption fails -> integration is dropped from the run,
  ends up in `integrationsSkipped`.
- A single preflight fails -> that integration shows up as
  `success: False` in the context block but the run continues.
- The sandbox itself fails to create (Modal outage, bad image) -> we
  log and fall back to "preflight-only synthesis" so the run still
  produces a usable report.
- Code generation fails -> the tool returns a stub result the
  orchestrator can see, so the ReAct loop isn't derailed.
- A single exec fails -> stderr surfaced back to the orchestrator as
  a ToolMessage; the code writer also gets to see the failure on its
  next call for self-correction.
- Synthesis fails -> shaped `IntegrationResearchReport` with the
  error in summary rather than raising.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from runner.chat.logging import chat_log
from runner.chat.models import get_gemini_pro
from runner.encryption import decrypt
from runner.research.code_writer import (
    CodeWriterOutput,
    PreviousExec,
    write_research_code,
)
from runner.research.docs import get_integration_docs_bundle
from runner.research.github_client import get_installation_token
from runner.research.github_repo_explorer import parse_repo_full_name
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
    IntegrationResearchReport,
    ResearchFinding,
)


# ---------------------------------------------------------------------------
# Pydantic schemas for Gemini structured output
# ---------------------------------------------------------------------------


class _AgentFinding(BaseModel):
    source: str = Field(
        description="Integration id: github, posthog, sentry, langsmith, braintrust."
    )
    category: str = Field(
        description=(
            "recent_changes, errors, user_behavior, performance, llm_failures, test_gaps"
        )
    )
    details: str = Field(
        description=(
            "One or two sentences describing the finding, ending with a concrete "
            "anchor (commit SHA, PR #, URL, error count, session ID)."
        )
    )
    severity: Literal["critical", "high", "medium", "low"]
    rawData: str | None = Field(
        default=None,
        description=(
            "Optional JSON string of supporting data (NOT natural language). "
            "Use this only when the anchor doesn't fit in `details`."
        ),
    )


class _AgentReport(BaseModel):
    summary: str = Field(description="3-6 sentences. Lead with the biggest risk.")
    findings: list[_AgentFinding] = Field(default_factory=list)
    recommendedFlows: list[str] = Field(default_factory=list)
    drillInHighlights: list[str] = Field(
        default_factory=list,
        description=(
            "3-6 one-sentence highlights naming SPECIFIC drill-in results "
            "worth surfacing to the chat orchestrator. Each must cite a "
            "concrete number or anchor from the research notes below (e.g. "
            "'PostHog: 48 `$exception` events on `/w/*/sheets/*` in the "
            "last 7 days, up from 2 the prior week'). Use this for signals "
            "too concrete to live in `summary` but that don't fit the "
            "categorical `findings` shape. Skip if no drill-ins produced "
            "useful output."
        ),
    )


# ---------------------------------------------------------------------------
# Preflight dispatch (unchanged from previous version — still our starting
# signal layer; the LLM drill-in sits on top of this, not in place of it.)
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
    """Fire all integration preflights in parallel. Same shape as before."""
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
            # the sandbox. That way the sandbox gets something narrowly
            # scoped (1h TTL, repo-specific) and can't impersonate the
            # whole GitHub App.
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
# System prompt for the orchestrator ReAct loop
# ---------------------------------------------------------------------------


def _build_orchestrator_system_prompt(
    app_url: str,
    integrations_covered: list[str],
) -> str:
    """System prompt for the Gemini 3.1 Pro orchestrator.

    The orchestrator does NOT write Python. It issues natural-language
    research goals via `execute_code(purpose=...)`; a separate code
    writer turns each goal into a script and runs it.

    The prompt emphasizes two things:

    1. **Cross-source ReAct.** The orchestrator can keep calling the
       tool across different integrations in any order, including
       correlating findings (e.g. GitHub PR #206 touched
       `app/checkout/` → let me ask PostHog whether `/checkout/*` has
       spiking rage-clicks in the same window).
    2. **Writing GOALS, not CODE.** The tool contract is purpose-based;
       any code-level details belong in the purpose as natural-language
       intent ("fetch the PR's changed files, filter to app/checkout/*,
       return filenames"), not Python.
    """
    return f"""You are the research orchestrator for QA planning on {app_url}. Your job is to decide WHAT to investigate across the connected integrations, not to write code.

You have one tool:

    execute_code(purpose: str) -> {{exit_code, stdout, stderr, explanation}}

Pass a clear, natural-language research goal as `purpose`. A specialized code-writer model will translate your purpose into a focused Python script and run it inside an isolated sandbox against the connected integration APIs, with credentials already preloaded as environment variables. You will see:

- `exit_code` — 0 on success, non-zero on failure (HTTP 4xx/5xx wrapped as JSON errors still count as success here; actual Python exceptions are non-zero).
- `stdout` — the script's printed JSON output (truncated to ~4KB if huge).
- `stderr` — any Python exception traceback or error stream (truncated).
- `explanation` — one-sentence note from the code writer describing what the script did (useful for verifying the code writer understood your goal).

# Connected integrations

{', '.join(integrations_covered)}

# How to write good `purpose` strings

BAD (too vague): "Investigate GitHub"
BAD (writing code): "Call GET /repos/owner/repo/pulls/206/files and print additions per file"
GOOD: "List the files changed in PR #206, grouped by top-level directory, with per-file additions and deletions. Return the top 10 largest-changed files."

A good purpose names:
- The provider (GitHub / PostHog / Sentry / LangSmith / Braintrust).
- The specific entity or range (PR #206, last 14 days of $exception events, Sentry issue with the highest count).
- The exact output shape you want ("return file counts grouped by directory", "return the top 5 rage-click URLs with counts", "join with timestamp").

# Cross-source investigation (do this!)

You have memory of every prior tool call in this conversation. Use it. Some of the highest-signal investigations correlate across integrations:

- "GitHub PR #206 touched app/checkout/* on Mar 14. Query PostHog for the count of $exception events on URLs matching /checkout/* in the 7 days AFTER Mar 14, compared to the 7 days before."
- "Sentry issue SENTRY-1234 points at a TypeError in ReactEditor.tsx. Query GitHub for the last 5 commits that touched files matching ReactEditor*, and return commit sha + message + author."
- "PostHog rage-click on /w/*/sheets/* is #1 at 290 events. Query LangSmith for error runs whose inputs reference sheet IDs or contain 'sheet', last 7 days, to see if an AI feature on that page is also failing."

The orchestrator that DOES correlate across providers surfaces much stronger QA signals than one that only drills into one source at a time.

# Loop discipline

- Each tool call is sequential. Wait for the previous result, read stdout, decide the next question.
- Stop calling tools when your next call wouldn't change the conclusions you'd write up. Don't pad.
- Step budget is ~20 total. Spend it on surfacing new anchored evidence, not re-verifying preflight numbers.

# What preflight already gave you

The user message below contains each integration's preflight result (recent commits/PRs, top rage-clicks, top unresolved Sentry issues, etc.) as JSON. Read it first; don't waste calls re-fetching what it already has.

When you have enough evidence-backed findings, stop calling tools. You'll then be asked for the structured report."""


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def _fallback_report(app_url: str, reason: str) -> IntegrationResearchReport:
    return IntegrationResearchReport(
        summary=reason,
        findings=[],
        recommendedFlows=[
            f"Homepage smoke test — open {app_url} and verify critical UI",
            "Primary navigation — exercise main routes and links",
            "Core user journey — sign-in, forms, or checkout if applicable",
        ],
        integrationsCovered=[],
        integrationsSkipped=[],
        drillInHighlights=[],
    )


def _resolve_configs(active_integrations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Decrypt and flatten active integration configs into `{type -> plain dict}`.

    Same as the previous version — the sandbox env construction uses the
    same `integration_configs` shape preflight uses.
    """
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
    """Truncate a string with a visible marker, used on tool output that goes
    back into the LLM context window (models choke on multi-MB stdout)."""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n\n[...truncated {len(s) - limit} more chars]"


async def _run_research_loop(
    app_url: str,
    integrations_covered: list[str],
    preflight_results: dict[str, dict[str, Any]],
    env: IntegrationEnv,
) -> list[str]:
    """ReAct loop where a Gemini 3.1 Pro orchestrator issues natural-language
    research goals and a separate Gemini 3.1 Pro code-writer produces the
    code that gets run in a Modal sandbox.

    Returns a list of "research notes" strings — one per execute_code
    call (purpose, code-writer explanation, exit_code, stdout, stderr)
    plus any intermediate orchestrator thoughts. These notes are what
    the synthesis pass reads.

    Cross-source ReAct works here because every prior tool call's
    result is appended to the orchestrator's `messages`, so turn N sees
    turns 1..N-1 in context. The orchestrator can pivot between
    providers freely and correlate findings across them.
    """
    max_steps = env_key_int("RESEARCH_INTEGRATION_MAX_STEPS", 20)

    import modal as _modal  # local import so module loads even if modal isn't importable elsewhere

    sb: _modal.Sandbox | None = None
    notes: list[str] = []

    try:
        sb = await create_research_sandbox(env)
    except Exception as e:
        chat_log(
            "warn",
            "research_sandbox_create_failed",
            err=repr(e),
        )
        return [
            f"[sandbox unavailable: {type(e).__name__}: {e}]\n"
            "Skipping research loop; falling back to preflight-only synthesis."
        ]

    # Pre-compute the provider docs block + env description once so the
    # code writer can re-use them on every call without the orchestrator
    # having to thread them through.
    docs_block = "\n\n---\n\n".join(
        f"## {t.upper()} API docs\n\n{doc}"
        for t, doc in get_integration_docs_bundle(integrations_covered).items()
    )
    env_description = env.describe()

    # Tracks the immediately-previous exec so the code writer can
    # self-correct on transient failures (wrong field name, missing
    # query param, etc.). One call's history only — we don't want the
    # code writer's prompt to balloon over the loop.
    previous_exec: PreviousExec | None = None

    # The tool is declared as `async def` so its body can await the
    # code-writer call directly. `@tool` preserves the signature
    # (`purpose: str`) and docstring for schema/binding purposes;
    # `bind_tools` accepts async tools, and the loop invokes them via
    # `await execute_code.ainvoke({...})`.
    #
    # The closure captures `sb`, `docs_block`, `env_description`,
    # `previous_exec`, and `notes` from the outer scope so the tool can
    # update loop-level state (carrying forward the previous exec for
    # code-writer self-correction, accumulating research notes for the
    # synthesis pass) without the orchestrator having to thread any of
    # it through.
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

        # Phase A: code writer produces the Python for this purpose.
        code_output: CodeWriterOutput = await write_research_code(
            purpose=purpose,
            docs_block=docs_block,
            env_description=env_description,
            previous_exec=previous_exec,
        )

        # Phase B: run the code in the sandbox.
        assert sb is not None  # create succeeded (else we bailed earlier)
        result: ExecResult = await execute_in_sandbox(sb, code_output.code)

        # Remember for the code writer's next call.
        previous_exec = PreviousExec(
            purpose=purpose,
            exit_code=result.exit_code,
            stderr_head=_truncate(result.stderr, 1000),
        )

        # Record a note for the synthesis pass. We INCLUDE the generated
        # code here (truncated) because synthesis may want to cite
        # "the script that ran HogQL X found..." even if the orchestrator
        # never saw the raw code.
        notes.append(
            f"[execute_code: {purpose}] exit {result.exit_code}\n"
            f"explanation: {code_output.explanation}\n"
            f"code ({len(code_output.code)} chars, truncated):\n"
            f"{_truncate(code_output.code, 2000)}\n"
            f"stdout:\n{_truncate(result.stdout, 8000)}\n"
            f"stderr:\n{_truncate(result.stderr, 2000)}"
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

        # What the orchestrator sees. Keep it tight — this lands in
        # context on every subsequent turn.
        return json.dumps(
            {
                "purpose": purpose,
                "explanation": code_output.explanation,
                "exit_code": result.exit_code,
                "stdout": _truncate(result.stdout, 4000),
                "stderr": _truncate(result.stderr, 1000),
            },
            default=str,
        )

    try:
        model = get_gemini_pro(max_tokens=4096).bind_tools([execute_code])

        # Build the initial user message: every integration's preflight
        # result as fenced JSON blocks.
        preflight_block = "\n\n".join(
            f"## {t.upper()} preflight\n\n```json\n{json.dumps(preflight_results[t], indent=2, default=str)}\n```"
            for t in integrations_covered
        )

        messages: list = [
            SystemMessage(
                content=_build_orchestrator_system_prompt(
                    app_url=app_url,
                    integrations_covered=integrations_covered,
                )
            ),
            HumanMessage(
                content=(
                    f"Investigate {', '.join(integrations_covered)} for QA test "
                    f"planning signals on {app_url}. Read the preflight data below, "
                    "pick the most promising signals, and call `execute_code` with "
                    "clear research goals — including cross-provider correlations "
                    "where they reveal more than single-source drill-ins. Stop "
                    "when you have enough evidence-backed findings.\n\n"
                    "# Preflight data\n\n"
                    f"{preflight_block}"
                )
            ),
        ]

        for step in range(max_steps):
            response: AIMessage = await model.ainvoke(messages)
            messages.append(response)

            # Capture any natural-language text blocks the orchestrator
            # emitted. These often contain the reasoning for the next
            # tool call, which is useful for synthesis.
            text_content: list[str] = []
            if isinstance(response.content, str) and response.content.strip():
                text_content.append(response.content.strip())
            elif isinstance(response.content, list):
                for block in response.content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        t = block.get("text")
                        if isinstance(t, str) and t.strip():
                            text_content.append(t.strip())
            if text_content:
                notes.append("[orchestrator_thought]\n" + "\n".join(text_content))

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:
                chat_log(
                    "info",
                    "research_loop_done",
                    step=step,
                    total_execs=sum(1 for n in notes if n.startswith("[execute_code:")),
                )
                break

            for tc in tool_calls:
                name = tc.get("name")
                args = tc.get("args") or {}
                if name != "execute_code":
                    tool_result = json.dumps(
                        {"error": f"Unknown tool '{name}'. Only execute_code is available."}
                    )
                elif not str(args.get("purpose") or "").strip():
                    # Defend against the model hallucinating a call with an
                    # empty purpose. Tell it why the call was a no-op.
                    tool_result = json.dumps(
                        {
                            "error": (
                                "execute_code requires a non-empty "
                                "`purpose` string describing the research goal."
                            )
                        }
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
                messages.append(
                    ToolMessage(
                        content=tool_result,
                        tool_call_id=tc["id"],
                        name="execute_code",
                    )
                )
        else:
            chat_log(
                "warn",
                "research_loop_step_budget_exhausted",
                max_steps=max_steps,
                total_execs=sum(1 for n in notes if n.startswith("[execute_code:")),
            )

        return notes

    finally:
        await teardown_sandbox(sb)


async def _synthesize_report(
    *,
    app_url: str,
    integrations_covered: list[str],
    integrations_skipped: list[str],
    preflight_results: dict[str, dict[str, Any]],
    research_notes: list[str],
) -> IntegrationResearchReport:
    """Second LLM call: structured output synthesis of preflight + notes.

    This is the piece that actually populates `IntegrationResearchReport`.
    Using `with_structured_output(..., method="json_schema")` forces the
    output into the right shape so the downstream flow-proposal generator
    can trust it.
    """
    preflight_block = "\n\n".join(
        f"## {t.upper()} preflight\n\n```json\n{json.dumps(preflight_results[t], indent=2, default=str)}\n```"
        for t in integrations_covered
    )
    notes_block = "\n\n---\n\n".join(research_notes) or "(No drill-in results.)"

    system = f"""You are a QA research agent synthesizing evidence-backed signals about {app_url} into a structured report. Your output feeds a downstream flow-proposer; be specific and anchored, not narrative.

# Output requirements

- `summary`: 3-6 sentences. Lead with the single biggest risk, then the next 1-2 themes. No preamble, no "this report covers...".
- `findings`: one entry per distinct, actionable signal. Each needs `source`, `category`, `severity`, a one- or two-sentence `details` that ends with a concrete anchor (commit SHA, PR #, URL, error count, session ID). Populate `rawData` (JSON string) whenever you have supporting numbers, IDs, URLs, or short lists that would help a downstream reviewer verify the finding — this field is rendered to the chat orchestrator, so prefer including it over omitting it. Keep each `rawData` under ~500 chars; just enough to ground the `details`.
- `recommendedFlows`: short phrases naming user-facing flows a QA human could recognize ("Autosave under concurrent editing", "Magic-link expiration recovery"). Prefer 5-10 strong candidates over 20 weak ones. Each must be traceable to at least one finding.
- `drillInHighlights`: 3-6 one-sentence callouts of SPECIFIC drill-in results from the research notes that are worth surfacing to the chat orchestrator verbatim. Each MUST cite a concrete number or anchor pulled from the `Drill-in research notes` section below (e.g. "PostHog: 48 $exception events on /w/*/sheets/* in the last 7 days, up from 2 the prior week" or "GitHub PR #412 touched 11 files under app/checkout/; largest diff was CheckoutFlow.tsx (+214/-38)"). This is the channel by which sandbox stdout evidence reaches downstream consumers — do not leave it empty unless drill-ins genuinely produced nothing useful.

# Prioritization

1. Regressions on recently merged PRs — especially large diffs, bug-fix series, or infra overhauls.
2. Pages with concrete user pain (rage clicks, exceptions, drop-off).
3. High-traffic journeys that would be embarrassing to break.
4. AI/LLM features with failing runs or score regressions."""

    human = f"""Produce the structured research report for {app_url} now.

Connected integrations with preflight data:
{', '.join(integrations_covered)}

Skipped (no data or errors):
{', '.join(integrations_skipped) or 'none'}

# Preflight data

{preflight_block}

# Drill-in research notes (what the investigator actually found)

{notes_block}"""

    model = get_gemini_pro(max_tokens=4096)
    structured = model.with_structured_output(_AgentReport, method="json_schema")
    try:
        agent_report: _AgentReport = await structured.ainvoke(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": human},
            ]
        )
    except Exception as e:
        chat_log("error", "research_integration_synthesis_failed", err=repr(e))
        return IntegrationResearchReport(
            summary=(
                f"Integration research synthesis failed: {type(e).__name__}: {e}. "
                f"Preflight data was collected for {', '.join(integrations_covered)}."
            ),
            findings=[],
            recommendedFlows=[],
            integrationsCovered=integrations_covered,
            integrationsSkipped=integrations_skipped,
            drillInHighlights=[],
        )

    findings = [
        ResearchFinding(
            source=f.source,
            category=f.category,
            details=f.details,
            severity=f.severity,
            rawData=f.rawData,
        )
        for f in agent_report.findings
    ]

    return IntegrationResearchReport(
        summary=agent_report.summary,
        findings=findings,
        recommendedFlows=agent_report.recommendedFlows,
        integrationsCovered=integrations_covered,
        integrationsSkipped=integrations_skipped,
        drillInHighlights=list(agent_report.drillInHighlights or []),
    )


async def run_integration_research(
    *,
    app_url: str,
    active_integrations: list[dict[str, Any]],
) -> IntegrationResearchReport:
    """End-to-end integration research pass.

    Orchestrates the three phases (preflight -> sandbox drill-in ->
    synthesis) and the graceful-degradation paths between them. Never
    raises; callers always get a shaped `IntegrationResearchReport`
    (possibly with error text in `summary` if everything failed).
    """
    if not active_integrations:
        return _fallback_report(
            app_url,
            "No integrations are connected. Recommendations are based on general "
            "best practices for the application URL.",
        )

    resolved = _resolve_configs(active_integrations)
    if not resolved:
        return _fallback_report(
            app_url,
            "Integrations are connected but credentials could not be resolved. "
            "Recommendations are based on general best practices.",
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
        return _fallback_report(
            app_url,
            "All integration preflights failed. Recommendations are based on "
            "general best practices.",
        )

    # Phase 2: sandbox-backed research loop. Orchestrator (Gemini 3.1 Pro)
    # picks the next question; the code-writer produces the code; sandbox
    # runs it.
    env = await _build_sandbox_env(resolved)
    try:
        research_notes = await _run_research_loop(
            app_url=app_url,
            integrations_covered=integrations_covered,
            preflight_results=preflight_results,
            env=env,
        )
    except Exception as e:
        chat_log("error", "research_loop_uncaught", err=repr(e))
        research_notes = [f"[research loop failed: {type(e).__name__}: {e}]"]

    chat_log(
        "info",
        "research_integration_loop_complete",
        note_count=len(research_notes),
        exec_count=sum(1 for n in research_notes if n.startswith("[execute_code:")),
    )

    # Phase 3: synthesize.
    return await _synthesize_report(
        app_url=app_url,
        integrations_covered=integrations_covered,
        integrations_skipped=integrations_skipped,
        preflight_results=preflight_results,
        research_notes=research_notes,
    )
