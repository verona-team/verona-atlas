"""Codebase exploration sub-agent.

A Gemini 3.1 Pro ReAct-style loop that walks the linked GitHub repo and
produces a `CodebaseExplorationResult`. Port of
`lib/research-agent/codebase-exploration-agent.ts`.

## Design

The agent is a tight loop:

  1. Agent LLM emits tool calls (list paths, read file, suggest important paths).
  2. Tool runner executes them against `github_repo_explorer`.
  3. Loop until `finish_codebase_exploration` is called or step budget is hit.

Rather than a LangGraph StateGraph for this sub-agent we use a simple
manual loop — it's conceptually a single node ("iterate tool calls until
done") and wrapping that in a StateGraph adds ceremony without helping
observability. LangSmith still traces each LLM call cleanly via
`ChatGoogleGenerativeAI`'s native integration.

## Tool shapes

Tools use LangChain `@tool`; the decorator auto-generates input schemas
from the function signature. All tools are synchronous wrappers around
async httpx calls — we `run` the async bit inside the tool via
`asyncio.run_coroutine_threadsafe` on the outer loop is overkill; instead
we make the whole loop `async` and pass an `httpx.AsyncClient` through
closure. Tools are defined as closures so they can see the shared client
and the path cache without module-level state.
"""
from __future__ import annotations

import json
import os
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from runner.chat.logging import chat_log
from runner.chat.models import get_gemini_pro
from runner.research.github_client import get_installation_token
from runner.research.github_repo_explorer import (
    DEFAULT_MAX_LIST_PATHS,
    DEFAULT_MAX_PATH_MATCHES,
    RepoRef,
    build_filtered_repo_paths,
    filter_paths,
    get_text_file_content,
    parse_repo_full_name,
    suggest_important_paths,
)
from runner.research.types import (
    CodebaseEvidenceSnippet,
    CodebaseExplorationResult,
    Confidence,
    empty_codebase_exploration,
)


# ----- Tool result pydantic models (for structured return in tool calls) -----


class _FinishEvidenceSnippet(BaseModel):
    """Finish-time shape for a code evidence snippet.

    Kept internal to this module (the agent fills it as part of the finish
    tool's arg schema) and projected onto the public
    `CodebaseEvidenceSnippet` before returning. We accept it here as a
    plain nested model so LangChain's tool arg schema inference gets the
    shape right.
    """

    path: str = Field(description="Repository path the snippet came from.")
    snippet: str = Field(
        description=(
            "Verbatim excerpt from the file (≤ 400 chars). Quote the "
            "actual code — do not paraphrase."
        )
    )
    relevance: str = Field(
        description="One short sentence on why this snippet matters for QA planning."
    )


class FinishPayload(BaseModel):
    """Shape the agent must fill in when calling `finish_codebase_exploration`."""

    summary: str = Field(description="3-5 sentences on what the app is and its dominant flow.")
    architecture: str = Field(description="Stack + routing model + auth strategy + notable patterns.")
    inferredUserFlows: list[str] = Field(
        description="Concrete UI-level user flows (e.g. 'Sign in with magic link')."
    )
    testingImplications: str = Field(description="Risks a QA human should prioritize.")
    keyPathsExamined: list[str] = Field(description="Files actually read that informed the answer.")
    confidence: Literal["high", "medium", "low"]
    truncationWarnings: list[str] = Field(
        description="Honest list of gaps (API errors, truncation, unread modules)."
    )
    keyEvidence: list[_FinishEvidenceSnippet] = Field(
        default_factory=list,
        description=(
            "3-6 short quoted snippets from files you actually read that most "
            "informed your conclusions. Each has path, a verbatim snippet "
            "(≤400 chars), and a one-sentence `relevance` note. Prefer lines "
            "that reveal behaviour (auth checks, route wiring, form "
            "validation, mutation surfaces) over boilerplate."
        ),
    )


# ----- System prompt (ported verbatim from TS) -----


def _build_system_prompt(repo_full_name: str) -> str:
    return f"""You are an expert software architect and QA strategist exploring the GitHub repository {repo_full_name}. Your output will directly feed QA test planning for the deployed web app, so focus on what a user would actually do in the UI.

# Approach

1. Start with `get_repo_ref` to know the default branch, then `suggest_important_paths` for a high-signal entrypoint list.
2. Read README, package.json / framework config (next.config.*, vite.config.*, nuxt.config.*, astro.config.*, svelte.config.*) to identify the framework, router, and any monorepo layout. This disambiguates where routes/pages live.
3. Explore the routing surface: `app/`, `src/app/`, `pages/`, `src/pages/`, `routes/`, or framework equivalent. Read representative route files — don't read every file, read the ones that reveal distinct user journeys (auth, onboarding, core workflows, forms, payments, settings).
4. Skim middleware/guards, auth helpers, and API route handlers only insofar as they reveal user-visible behaviour. Skip pure utility and type-only files.
5. Binary assets and dependency folders are already filtered from listings.

# Efficiency

- Prefer listing + targeted reads over broad enumeration. One good read beats three skimmed ones.
- Stop exploring a path when returns diminish. You have a hard step budget — spend it where it reveals new flows, not to confirm what you already inferred.

# Finish

When you have enough to describe the app's real user journeys, call `finish_codebase_exploration`.
- `summary`: 3-5 sentences. What kind of app is this, what's its primary value to a user, and what is the dominant flow.
- `architecture`: stack + routing model + auth strategy + any notable patterns (monorepo, server actions, tRPC, etc.).
- `inferredUserFlows`: concrete, UI-level flows a user actually does — each phrased as a short action ("Sign in with magic link", "Create a new sheet and add columns"). Derive from routes/pages/components, not from tech.
- `testingImplications`: risks a QA human should prioritize given what you saw (auth surface area, payment flows, forms with complex validation, new or heavily churned modules, accessibility traps).
- `keyPathsExamined`: the files you actually read that most informed your answer.
- `confidence`: high / medium / low. Use low if you hit API errors, repo was truncated, or you didn't get to read a meaningful cross-section.
- `truncationWarnings`: honest list of gaps (e.g. "Could not read src/lib/payments - GitHub returned 404").
- `keyEvidence`: 3-6 short, quoted code snippets from files you actually read that most informed your conclusions. This is the one channel the downstream orchestrator has to cite code — prefer lines that reveal behaviour (auth checks, route wiring, form validation, mutations, error-prone code paths) over boilerplate. Each entry has `path`, a verbatim `snippet` (≤400 chars; quote the code, don't paraphrase), and a one-sentence `relevance` note. Skip this only if the exploration failed so severely you have nothing worth quoting.

If you hit errors or a huge repo, still finish with lower confidence rather than leaving empty."""


def _env_int(name: str, fallback: int) -> int:
    val = os.environ.get(name)
    if not val:
        return fallback
    try:
        n = int(val)
        return n if n > 0 else fallback
    except ValueError:
        return fallback


# ----- Main entry point -----


async def run_codebase_exploration_agent(
    *,
    installation_id: int,
    repo_full_name: str,
) -> CodebaseExplorationResult:
    """Run the codebase exploration sub-agent and return a typed result.

    Steps:

    1. Resolve an installation token.
    2. Build a Gemini 3.1 Pro ChatGoogleGenerativeAI bound to our closure-backed tools.
    3. Loop: invoke(messages) -> if tool_calls, execute them and append
       ToolMessages; else done. Stop on `finish_codebase_exploration` or
       after `RESEARCH_CODEBASE_MAX_STEPS` iterations.
    4. If finish tool was called, return its payload augmented with
       tool-steps count and tree warnings.
    5. Otherwise return a low-confidence stub.

    The loop body is intentionally explicit rather than using LangGraph's
    `create_agent` because:

    - We need custom stop conditions (the finish tool).
    - We want per-iteration logging that maps onto our `chat_log` event
      taxonomy.
    - The code is short enough that wrapping it in a graph adds more
      ceremony than it removes.
    """
    max_steps = _env_int("RESEARCH_CODEBASE_MAX_STEPS", 32)

    parsed = parse_repo_full_name(repo_full_name)
    if parsed is None:
        return empty_codebase_exploration(
            summary="Invalid repository name (expected owner/repo).",
            truncation_warnings=["Could not parse GITHUB_REPOS."],
        )

    ref: RepoRef = parsed
    token = await get_installation_token(installation_id)

    # Shared state captured by tool closures. Kept as mutable lists/dicts so
    # the outer function can read the final values after the loop.
    cached_paths: list[str] | None = None
    cached_branch: str | None = None
    tree_warnings: list[str] = []
    tree_truncated = False
    tool_steps: list[dict[str, str]] = []
    finished_payload: FinishPayload | None = None

    async with httpx.AsyncClient(timeout=60.0) as http_client:

        async def _ensure_tree() -> None:
            nonlocal cached_paths, cached_branch, tree_warnings, tree_truncated
            if cached_paths is not None:
                return
            result = await build_filtered_repo_paths(http_client, token, ref)
            cached_paths = result.paths
            cached_branch = result.default_branch
            tree_truncated = result.truncated
            tree_warnings = list(result.warnings)

        # ---- Tool definitions (closures over shared state) ----

        @tool
        async def get_repo_ref() -> dict:
            """Get the default branch name and indexed path count for the repository."""
            tool_steps.append({"tool": "get_repo_ref", "detail": "default branch"})
            await _ensure_tree()
            return {
                "defaultBranch": cached_branch,
                "pathCount": len(cached_paths or []),
                "treeTruncatedFromApi": tree_truncated,
                "warnings": tree_warnings,
            }

        @tool
        async def list_repo_paths(
            prefix: str | None = None,
            substring: str | None = None,
            globSuffix: str | None = None,
            maxResults: int | None = None,
        ) -> dict:
            """List file paths in the repo. Optionally filter by directory prefix,
            substring, or file extension (e.g. ".tsx"). Results are capped."""
            tool_steps.append(
                {
                    "tool": "list_repo_paths",
                    "detail": " ".join(
                        x for x in [prefix, substring, globSuffix] if x
                    )
                    or "all",
                }
            )
            await _ensure_tree()
            cap = min(maxResults or DEFAULT_MAX_LIST_PATHS, DEFAULT_MAX_LIST_PATHS)
            paths, truncated = filter_paths(
                cached_paths or [],
                prefix=prefix,
                substring=substring,
                glob_suffix=globSuffix,
                max_results=cap,
            )
            return {"pathCount": len(paths), "truncated": truncated, "paths": paths}

        @tool
        async def get_file_content(path: str) -> dict:
            """Read a text file from the repository at the given path (UTF-8)."""
            tool_steps.append({"tool": "get_file_content", "detail": path})
            await _ensure_tree()
            branch = cached_branch or "HEAD"
            result = await get_text_file_content(http_client, token, ref, path, branch)
            if not result.ok:
                return {"ok": False, "path": path, "error": result.error}
            return {
                "ok": True,
                "path": path,
                "truncated": result.truncated,
                "size": result.size,
                "content": result.content,
            }

        @tool
        async def search_repo_paths(
            query: str,
            maxMatches: int | None = None,
        ) -> dict:
            """Search indexed paths by substring (case-insensitive). Returns up to maxMatches paths."""
            tool_steps.append({"tool": "search_repo_paths", "detail": query})
            await _ensure_tree()
            q = query.lower()
            cap = min(maxMatches or DEFAULT_MAX_PATH_MATCHES, DEFAULT_MAX_PATH_MATCHES)
            all_hits = [p for p in (cached_paths or []) if q in p.lower()]
            hits = all_hits[:cap]
            return {
                "matchCount": len(hits),
                "truncated": len(all_hits) > len(hits),
                "paths": hits,
            }

        @tool
        async def suggest_important_paths_tool() -> dict:
            """Get a short list of likely-important paths (configs, app routes, README)."""
            tool_steps.append(
                {"tool": "suggest_important_paths", "detail": "heuristic"}
            )
            await _ensure_tree()
            return {"suggestedPaths": suggest_important_paths(cached_paths or [])}

        @tool
        async def finish_codebase_exploration(
            summary: str,
            architecture: str,
            inferredUserFlows: list[str],
            testingImplications: str,
            keyPathsExamined: list[str],
            confidence: Literal["high", "medium", "low"],
            truncationWarnings: list[str],
            keyEvidence: list[dict] | None = None,
        ) -> dict:
            """Call when you have enough understanding of the codebase to inform QA.
            Provide structured fields per the system prompt.

            `keyEvidence` is a list of `{path, snippet, relevance}` objects;
            each snippet should be ≤400 chars of verbatim code with a one-
            sentence note on why it matters for QA planning.
            """
            nonlocal finished_payload
            tool_steps.append(
                {"tool": "finish_codebase_exploration", "detail": "done"}
            )
            parsed_evidence: list[_FinishEvidenceSnippet] = []
            for item in keyEvidence or []:
                if not isinstance(item, dict):
                    continue
                try:
                    parsed_evidence.append(_FinishEvidenceSnippet(**item))
                except Exception:
                    # Tolerate partial/malformed snippets rather than failing
                    # the whole finish call — the rest of the payload is
                    # still useful.
                    continue
            finished_payload = FinishPayload(
                summary=summary,
                architecture=architecture,
                inferredUserFlows=inferredUserFlows,
                testingImplications=testingImplications,
                keyPathsExamined=keyPathsExamined,
                confidence=confidence,
                truncationWarnings=truncationWarnings,
                keyEvidence=parsed_evidence,
            )
            return {"finished": True}

        # Rename for LangChain (the `_tool` suffix is an internal disambiguation).
        suggest_important_paths_tool.name = "suggest_important_paths"

        tools = [
            get_repo_ref,
            list_repo_paths,
            get_file_content,
            search_repo_paths,
            suggest_important_paths_tool,
            finish_codebase_exploration,
        ]
        tools_by_name = {t.name: t for t in tools}

        model = get_gemini_pro().bind_tools(tools)

        messages: list = [
            SystemMessage(content=_build_system_prompt(repo_full_name)),
            HumanMessage(
                content=(
                    f"Explore {repo_full_name} to map its real user-facing flows for QA "
                    "planning. Use the tools iteratively — start from routes/pages, read "
                    "enough representative files to infer the main journeys (auth, core "
                    "workflow, forms, settings), and finish by calling "
                    "`finish_codebase_exploration` with concrete inferredUserFlows and "
                    "testingImplications."
                )
            ),
        ]

        # ---- ReAct loop ----
        for step in range(max_steps):
            response: AIMessage = await model.ainvoke(messages)
            messages.append(response)

            if not getattr(response, "tool_calls", None):
                chat_log(
                    "info",
                    "research_codebase_llm_stopped_without_tools",
                    step=step,
                    repo=repo_full_name,
                )
                break

            # Run each requested tool; append ToolMessages so the LLM sees results.
            for tool_call in response.tool_calls:
                name = tool_call["name"]
                args = tool_call.get("args") or {}
                fn = tools_by_name.get(name)
                if fn is None:
                    result: Any = {"error": f"Unknown tool: {name}"}
                else:
                    try:
                        result = await fn.ainvoke(args)
                    except Exception as e:
                        chat_log(
                            "error",
                            "research_codebase_tool_error",
                            tool=name,
                            err=repr(e),
                        )
                        result = {"error": f"{type(e).__name__}: {e}"}

                messages.append(
                    ToolMessage(
                        content=json.dumps(result, default=str),
                        tool_call_id=tool_call["id"],
                        name=name,
                    )
                )

            if finished_payload is not None:
                break
        else:
            chat_log(
                "warn",
                "research_codebase_step_budget_exhausted",
                max_steps=max_steps,
                repo=repo_full_name,
            )

    if finished_payload is not None:
        merged_warnings = list(finished_payload.truncationWarnings)
        merged_warnings.extend(tree_warnings)
        if tree_truncated:
            merged_warnings.append("GitHub tree API marked truncated=true.")
        # Defensive snippet-length cap. The prompt asks for ≤400 chars but
        # the model occasionally ignores length hints; capping here keeps the
        # eventual orchestrator prompt bounded no matter what.
        _SNIPPET_MAX = 600
        key_evidence = [
            CodebaseEvidenceSnippet(
                path=e.path,
                snippet=(
                    e.snippet if len(e.snippet) <= _SNIPPET_MAX
                    else e.snippet[:_SNIPPET_MAX] + "…"
                ),
                relevance=e.relevance,
            )
            for e in finished_payload.keyEvidence
        ]
        return CodebaseExplorationResult(
            summary=finished_payload.summary,
            architecture=finished_payload.architecture,
            inferredUserFlows=finished_payload.inferredUserFlows,
            testingImplications=finished_payload.testingImplications,
            keyPathsExamined=finished_payload.keyPathsExamined,
            confidence=finished_payload.confidence,
            truncationWarnings=merged_warnings,
            toolStepsUsed=len(tool_steps),
            keyEvidence=key_evidence,
        )

    # Didn't call finish — return a low-confidence summary based on what we read.
    return empty_codebase_exploration(
        summary=(
            f"Codebase exploration did not finish before step limit ({max_steps}). "
            "Partial understanding only."
        ),
        architecture="Unknown — agent did not call finish_codebase_exploration.",
        inferred_user_flows=[],
        testing_implications=(
            "Re-run research or increase RESEARCH_CODEBASE_MAX_STEPS."
        ),
        key_paths_examined=[
            t["detail"] for t in tool_steps if t["tool"] == "get_file_content"
        ],
        confidence="low",
        truncation_warnings=[
            f"Stopped after {max_steps} steps without finish_codebase_exploration.",
            *tree_warnings,
        ],
        tool_steps_used=len(tool_steps),
    )
