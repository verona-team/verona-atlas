"""Integration research sub-agent.

Produces a structured `IntegrationResearchReport` for a project by
combining three passes:

    1. **Preflight** — fixed httpx calls per integration that gather the
       obvious first-layer signal (recent PRs, top rage-click URLs,
       top unresolved issues, etc.). Same as the previous version.

    2. **Deep exploration (Modal Sandbox + Sonnet ReAct loop)** — Claude
       is given one tool, `execute_code`, that runs arbitrary Python
       inside a gVisor-isolated Modal Sandbox. Preflight results are
       injected as context; Claude decides what follow-up API calls
       would yield insight and writes the code to make them. Env vars
       (decrypted credentials + public config like hostnames) are
       pre-populated inside the sandbox so the scripts can read from
       `os.environ` rather than having creds passed as tool args.

    3. **Synthesis** — a single Sonnet structured-output call that
       turns preflight data + research notes (what Claude tried and
       what it found) into the final `IntegrationResearchReport`.

## Why the sandbox is back

The previous Python version skipped the sandbox loop — it was a
deliberate simplification because the old TS version of the sandbox
loop rarely produced findings that preflight didn't already surface.
But "rarely" is not "never," and for integrations with rich APIs
(PostHog HogQL, Sentry issue drilling, LangSmith run trees, GitHub
blame/file history) the drill-in genuinely surfaces anchors that a
fixed preflight can't anticipate. With Modal Sandboxes, the cost of
supporting this pattern is significantly lower than the Vercel Sandbox
version was: one long-lived sandbox per run, creds as env vars, Python
inside instead of JS. So the loop is back.

## Error handling

Every layer has a graceful-degradation path:

- Credential decryption fails -> integration is dropped from the run,
  ends up in `integrationsSkipped`.
- A single preflight fails -> that integration shows up as
  `success: False` in the context block but the run continues.
- The sandbox itself fails to create (Modal outage, bad image) -> we
  log and fall back to "preflight-only synthesis" so the run still
  produces a usable report.
- A single `execute_code` call fails -> its stderr is surfaced to
  Claude via a `ToolMessage`, so Claude can learn and retry.
- Synthesis fails -> we return a shaped `IntegrationResearchReport`
  with the error in the summary rather than raising.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from runner.chat.logging import chat_log
from runner.chat.models import get_sonnet
from runner.encryption import decrypt
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
# Pydantic schemas for Sonnet structured output
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
    integration has a predictable env var naming scheme so Claude can
    write scripts like `os.environ["POSTHOG_API_KEY"]` without having
    to be told the value up-front.

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
# System prompt for the drill-in ReAct loop
# ---------------------------------------------------------------------------


def _build_drill_in_system_prompt(
    app_url: str,
    integrations_covered: list[str],
    env: IntegrationEnv,
) -> str:
    """System prompt for the sandbox-backed ReAct loop.

    The prompt is responsible for documenting:
    - Which env vars the sandbox has (the only contract Claude has to
      the outside world).
    - Which auth header format each provider wants (replacement for the
      old Vercel Sandbox's auto-injected headers).
    - What a "good" drill-in looks like vs. churn.
    """
    return f"""You are a QA research investigator doing deep exploration of connected integrations for {app_url}. You have preflight data from each integration already (shown in the user message) and one tool to go deeper:

    execute_code(code: str, purpose: str) -> exit_code + stdout + stderr

This tool runs arbitrary **Python 3.13** inside an isolated Modal Sandbox with `httpx` preinstalled and the following environment variables already set:

{env.describe()}

# Auth headers (you set these yourself — there is no injection)

- GitHub: `Authorization: token ${{GITHUB_INSTALLATION_TOKEN}}`, `Accept: application/vnd.github.v3+json`, `X-GitHub-Api-Version: 2022-11-28`. Base URL: `https://api.github.com`. `GITHUB_REPO` is `owner/repo`.
- PostHog: `Authorization: Bearer ${{POSTHOG_API_KEY}}`. Base URL: `$POSTHOG_HOST`. Project id: `$POSTHOG_PROJECT_ID`.
- Sentry: `Authorization: Bearer ${{SENTRY_AUTH_TOKEN}}`. Base URL: `https://sentry.io/api/0`. Org slug: `$SENTRY_ORG_SLUG`, project slug: `$SENTRY_PROJECT_SLUG`.
- LangSmith: `X-API-Key: ${{LANGSMITH_API_KEY}}`. Base URL: `https://api.smith.langchain.com`. Project name (optional): `$LANGSMITH_PROJECT_NAME`.
- Braintrust: `Authorization: Bearer ${{BRAINTRUST_API_KEY}}`. Base URL: `https://api.braintrust.dev`.

# How to use execute_code

- Each call is a fresh Python process (no state survives between calls). Imports, variables, and `httpx.Client` instances reset.
- Return data via `print(json.dumps(...))`. Keep each call focused on ONE question. Large responses will be truncated on your next turn — if you need to correlate, save the interesting slice first, then re-query.
- `httpx` (sync) is preinstalled; `json`, `os` are stdlib. If you want an async client, use `httpx.AsyncClient`.
- Wrap HTTP calls in try/except so the script exits cleanly even on 4xx/5xx.
- NEVER set auth headers from hardcoded strings — always read from `os.environ`.
- Sequential calls only (one execute_code per turn).

# Investigation approach

1. **Read preflight first.** The user message has every integration's preflight result as JSON. That's the first-layer signal — do not re-fetch what it already has.
2. **Drill into what's interesting.** Pick 1-3 signals that look QA-relevant per integration and go deeper:
   - **GitHub**: biggest PRs → which files changed → who touched them recently; open issues labeled bug/regression; compare two commits to understand a migration.
   - **PostHog**: top rage-click URL → pull a matching session recording's events (`POST /query/` with HogQL against `session_replay_events`); repeated exception messages → correlate with URL + affected users + first/last seen.
   - **Sentry**: top unresolved issue → fetch events via `GET /issues/{{issue_id}}/events/` to see stack traces + affected URLs; check `GET /projects/{{org}}/{{proj}}/releases/` for recent deploys that might be the cause.
   - **LangSmith**: list sessions, query error runs per session, pull one error run's full inputs/outputs to understand the failure mode.
   - **Braintrust**: recent experiments per project, fetch one experiment's logs to see score regressions.
3. **Correlate across integrations.** A PostHog rage-click URL that matches a GitHub PR's changed files is a much stronger signal than either alone.
4. **Stop when the marginal drill-in no longer changes your conclusions.** You have a hard step budget; spend it on surfacing new evidence, not confirming what you already know.

# What "good" looks like

Every drill-in should surface something with a concrete anchor (commit SHA, PR #, URL, error count, session ID) that a downstream writer can cite. If your next call is just "let me verify that existing preflight number" — don't; move on.

Connected integrations: {', '.join(integrations_covered)}

When you have enough to produce an evidence-backed report, stop calling tools. You'll then be asked for the structured output."""


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
    back into the LLM context window (Claude chokes on multi-MB stdout)."""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n\n[...truncated {len(s) - limit} more chars]"


async def _run_drill_in_loop(
    app_url: str,
    integrations_covered: list[str],
    preflight_results: dict[str, dict[str, Any]],
    env: IntegrationEnv,
) -> list[str]:
    """ReAct loop: Claude writes Python, runs in sandbox, reads stdout, repeats.

    Returns a list of "research notes" strings — one per execute_code call,
    containing (purpose, exit_code, stdout, stderr) — plus any intermediate
    natural-language thoughts Claude emitted between tool calls. These
    notes are what the synthesis pass reads.
    """
    max_steps = env_key_int("RESEARCH_INTEGRATION_MAX_STEPS", 20)

    import modal as _modal  # local import so module loads even if modal isn't importable elsewhere

    sb: _modal.Sandbox | None = None
    notes: list[str] = []

    try:
        sb = create_research_sandbox(env)
    except Exception as e:
        chat_log(
            "warn",
            "research_sandbox_create_failed",
            err=repr(e),
        )
        return [
            f"[sandbox unavailable: {type(e).__name__}: {e}]\n"
            "Skipping drill-in phase; falling back to preflight-only synthesis."
        ]

    # Closure-bound tool that records every call into `notes`.
    @tool
    def execute_code(code: str, purpose: str) -> str:
        """Execute Python 3.13 code in the research sandbox with integration
        credentials preloaded as environment variables.

        Args:
            code: Python source. Return data by print()ing JSON. Max ~1.5MB.
            purpose: One short sentence explaining what this call investigates.
        """
        # Bypasses `sb is None` — create_research_sandbox either returned a
        # live sandbox or we already returned the fallback notes above.
        assert sb is not None
        result: ExecResult = execute_in_sandbox(sb, code)

        # Keep a compact record for the synthesis pass. Truncate aggressively
        # here because these notes go straight into a future LLM prompt.
        note = (
            f"[execute_code: {purpose}] exit {result.exit_code}\n"
            f"stdout:\n{_truncate(result.stdout, 8000)}\n"
            f"stderr:\n{_truncate(result.stderr, 2000)}"
        )
        notes.append(note)

        chat_log(
            "info",
            "research_sandbox_exec",
            purpose=purpose,
            exit_code=result.exit_code,
            code_length=len(code),
            stdout_length=len(result.stdout),
            stderr_length=len(result.stderr),
        )

        # What we return to the LLM needs to be truncated more aggressively
        # than what we save in `notes` — the LLM will see this in-context on
        # every subsequent tool call, so keeping it tight matters for both
        # cost and attention budget.
        return json.dumps(
            {
                "purpose": purpose,
                "exit_code": result.exit_code,
                "stdout": _truncate(result.stdout, 4000),
                "stderr": _truncate(result.stderr, 1000),
            }
        )

    try:
        model = get_sonnet(max_tokens=4096, temperature=0.1).bind_tools([execute_code])

        # Build the initial user message: every integration's preflight
        # result as fenced JSON blocks.
        preflight_block = "\n\n".join(
            f"## {t.upper()} preflight\n\n```json\n{json.dumps(preflight_results[t], indent=2, default=str)}\n```"
            for t in integrations_covered
        )
        docs_block = "\n\n---\n\n".join(
            f"## {t.upper()} API docs\n\n{doc}"
            for t, doc in get_integration_docs_bundle(integrations_covered).items()
        )

        messages: list = [
            SystemMessage(
                content=_build_drill_in_system_prompt(
                    app_url=app_url,
                    integrations_covered=integrations_covered,
                    env=env,
                )
            ),
            HumanMessage(
                content=(
                    f"Investigate {', '.join(integrations_covered)} for QA test "
                    f"planning signals on {app_url}. Start by reading the preflight "
                    "data below, pick the 2-4 most promising signals, and use "
                    "execute_code to drill in. When you've surfaced enough "
                    "evidence-backed findings, stop calling tools.\n\n"
                    "# Preflight data\n\n"
                    f"{preflight_block}\n\n"
                    "# Provider API reference\n\n"
                    f"{docs_block}"
                )
            ),
        ]

        for step in range(max_steps):
            response: AIMessage = await model.ainvoke(messages)
            messages.append(response)

            # Capture any natural-language text blocks the model emitted
            # alongside the tool calls (or after the last one). This is
            # where Claude often summarizes what it learned before calling
            # the next tool — the synthesis pass benefits from seeing it.
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
                notes.append("[agent_thought]\n" + "\n".join(text_content))

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:
                chat_log(
                    "info",
                    "research_sandbox_loop_done",
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
                else:
                    # Invoke synchronously — the tool closure already handled
                    # running the sandbox exec (which itself blocks on stdout).
                    try:
                        tool_result = execute_code.invoke(args)
                    except Exception as e:
                        chat_log(
                            "error",
                            "research_sandbox_tool_invoke_failed",
                            err=repr(e),
                        )
                        tool_result = json.dumps(
                            {"error": f"{type(e).__name__}: {e}"}
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
                "research_sandbox_loop_step_budget_exhausted",
                max_steps=max_steps,
                total_execs=sum(1 for n in notes if n.startswith("[execute_code:")),
            )

        return notes

    finally:
        teardown_sandbox(sb)


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
- `findings`: one entry per distinct, actionable signal. Each needs `source`, `category`, `severity`, a one- or two-sentence `details` that ends with a concrete anchor (commit SHA, PR #, URL, error count, session ID). Use `rawData` (JSON string) ONLY when the anchor doesn't fit naturally in prose.
- `recommendedFlows`: short phrases naming user-facing flows a QA human could recognize ("Autosave under concurrent editing", "Magic-link expiration recovery"). Prefer 5-10 strong candidates over 20 weak ones. Each must be traceable to at least one finding.

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

    model = get_sonnet(max_tokens=4096, temperature=0.1)
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

    # Phase 2: sandbox-backed drill-in. Runs asynchronously alongside
    # nothing else — synthesis needs the notes.
    env = await _build_sandbox_env(resolved)
    try:
        research_notes = await _run_drill_in_loop(
            app_url=app_url,
            integrations_covered=integrations_covered,
            preflight_results=preflight_results,
            env=env,
        )
    except Exception as e:
        chat_log("error", "research_sandbox_loop_uncaught", err=repr(e))
        research_notes = [f"[drill-in failed: {type(e).__name__}: {e}]"]

    chat_log(
        "info",
        "research_integration_drill_in_complete",
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
