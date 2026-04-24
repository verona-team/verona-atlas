"""Codebase exploration sub-agent.

A Gemini 3.1 Pro ReAct-style loop that walks the linked GitHub repo and
produces a `CodebaseTranscript` — the raw investigation log that the
synthesis stage (`runner.research.synthesizer`) later turns into the
structured `CodebaseExplorationResult` on `ResearchReport`.

## Design

The agent is a tight loop:

  1. Agent LLM emits tool calls (list paths, read file, search).
  2. Tool runner executes them against `github_repo_explorer`.
  3. Any natural-language text blocks the LLM emitted alongside tool
     calls are captured as `TranscriptEntry(kind="thought", ...)` so
     the synthesizer later sees the investigator's reasoning.
  4. Loop until the LLM stops emitting tool calls (natural stop) or the
     step budget is hit.
  5. When the LLM stops, the final AIMessage's text content becomes the
     transcript's `orientation` — a 3-5 sentence handoff blurb for the
     synthesizer.

Rather than a LangGraph StateGraph for this sub-agent we use a simple
manual loop — it's conceptually a single node ("iterate tool calls until
done") and wrapping that in a StateGraph adds ceremony without helping
observability. LangSmith still traces each LLM call cleanly via
`ChatGoogleGenerativeAI`'s native integration.

## Why the agent no longer emits structured output directly

Previously this agent owned a `finish_codebase_exploration` tool that
forced it to produce the full `CodebaseExplorationResult` as structured
tool args. That mixed two jobs — *explore the repo* and *write the
final structured summary* — into one LLM call at the end of the ReAct
loop. Splitting them lets each role have a tighter, purpose-built
prompt:

- This agent focuses on exploration: which files to read, in what
  order, to understand the user-facing flows of the app.
- The synthesizer focuses on summarization: given the full exploration
  transcript, produce the structured `CodebaseExplorationResult`.

Net benefit: the investigator never has to narrate structured fields
mid-loop, the synthesizer gets the full un-summarized exploration
(including inner thoughts) instead of a compressed finish payload, and
the two prompts can evolve independently.

## Tool shapes

Tools use LangChain `@tool`; the decorator auto-generates input schemas
from the function signature. Tools are defined as closures over the
shared httpx client and path cache so their bodies can stay short.
"""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

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
    CodebaseTranscript,
    TranscriptEntry,
)


# ----- Helpers to capture AI text blocks as transcript thoughts -----


def _extract_text_blocks(response: AIMessage) -> list[str]:
    """Return the non-empty text fragments from an AIMessage's content.

    The agent prompt encourages the model to narrate its plan between
    tool calls. Capturing those fragments as `[thought]` entries gives
    the synthesizer a clean view of *why* each file was read, which is
    information it otherwise couldn't reconstruct from the tool log.
    """
    content = response.content
    texts: list[str] = []
    if isinstance(content, str):
        if content.strip():
            texts.append(content.strip())
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str) and t.strip():
                    texts.append(t.strip())
    return texts


# ----- System prompt -----


def _build_system_prompt(repo_full_name: str) -> str:
    return f"""You are an expert software architect and QA strategist exploring the GitHub repository {repo_full_name}. Your output will directly feed QA test planning for the deployed web app, so focus on what a user would actually do in the UI.

# Your goal

Map the top 8-12 core user-facing flows of this app — the things a signed-in user does in a typical session — with enough evidence (routes, key components, form/mutation surfaces, auth gates) that a downstream synthesizer could describe them without opening the repo. Surface the architecture (stack, routing model, auth strategy) and any risks a QA human should prioritize.

# Approach

1. Start with `get_repo_ref` to know the default branch, then `suggest_important_paths` for a high-signal entrypoint list.
2. Read README, package.json / framework config (next.config.*, vite.config.*, nuxt.config.*, astro.config.*, svelte.config.*) to identify the framework, router, and any monorepo layout. This disambiguates where routes/pages live.
3. Explore the routing surface: `app/`, `src/app/`, `pages/`, `src/pages/`, `routes/`, or framework equivalent. Read representative route files — don't read every file, read the ones that reveal distinct user journeys (auth, onboarding, core workflows, forms, payments, settings).
4. Skim middleware/guards, auth helpers, and API route handlers only insofar as they reveal user-visible behaviour. Skip pure utility and type-only files.
5. Binary assets and dependency folders are already filtered from listings.

# Efficiency

- Prefer listing + targeted reads over broad enumeration. One good read beats three skimmed ones.
- Stop exploring a path when returns diminish. You have a hard step budget — spend it where it reveals new flows, not to confirm what you already inferred.
- Narrate your plan in short text blocks between tool calls when it helps — those thoughts are preserved for the downstream synthesizer.

# How to finish

When you have enough to describe the app's real user journeys, STOP calling tools and emit a final message with no tool calls. In that final message, write a 3-5 sentence summary of what you learned:

- What kind of app this is and its primary value to a user.
- Stack + routing model + auth strategy + any notable patterns (monorepo, server actions, tRPC, etc.).
- The dominant user flow.

That summary becomes your handoff to the synthesizer. Do NOT try to produce structured fields (inferredUserFlows, keyEvidence, confidence, etc.) — those are the synthesizer's job. Focus your final message on a clear, accurate narrative paragraph.

If you hit API errors or a huge/truncated repo, still stop cleanly with a brief honest summary of what you did see.
"""


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


async def run_codebase_exploration_transcript(
    *,
    installation_id: int,
    repo_full_name: str,
) -> CodebaseTranscript:
    """Run the codebase exploration sub-agent and return a transcript.

    The transcript is the un-summarized investigation log: a list of
    `TranscriptEntry` objects (thoughts and tool calls) plus repo
    metadata and a final orientation blurb. The synthesis stage
    (`runner.research.synthesizer.generate_codebase_exploration`) turns
    this into the structured `CodebaseExplorationResult`.

    Steps:

    1. Resolve an installation token.
    2. Build a Gemini 3.1 Pro ChatGoogleGenerativeAI bound to our
       closure-backed tools.
    3. Loop: invoke(messages) -> if tool_calls, execute them and append
       ToolMessages; else the loop ends and we capture the final
       AIMessage's text as `orientation`.
    4. Return the assembled `CodebaseTranscript`.

    The loop body is intentionally explicit rather than using LangGraph's
    `create_agent` because we need custom stop conditions (natural stop
    when no tool calls are emitted), per-iteration logging that maps onto
    our `chat_log` event taxonomy, and first-class capture of text
    blocks as transcript thoughts.
    """
    max_steps = _env_int("RESEARCH_CODEBASE_MAX_STEPS", 32)

    parsed = parse_repo_full_name(repo_full_name)
    if parsed is None:
        return CodebaseTranscript(
            repo_full_name=repo_full_name,
            default_branch=None,
            path_count=0,
            tree_truncated=False,
            tree_warnings=["Invalid repository name (expected owner/repo)."],
            orientation="Invalid repository name (expected owner/repo).",
            entries=[],
            step_budget_exhausted=False,
        )

    ref: RepoRef = parsed
    token = await get_installation_token(installation_id)

    # Shared state captured by tool closures. Kept mutable so the outer
    # function can read final values after the loop.
    cached_paths: list[str] | None = None
    cached_branch: str | None = None
    tree_warnings: list[str] = []
    tree_truncated = False
    entries: list[TranscriptEntry] = []

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
            await _ensure_tree()
            return {"suggestedPaths": suggest_important_paths(cached_paths or [])}

        # Rename for LangChain (the `_tool` suffix is an internal disambiguation).
        suggest_important_paths_tool.name = "suggest_important_paths"

        tools = [
            get_repo_ref,
            list_repo_paths,
            get_file_content,
            search_repo_paths,
            suggest_important_paths_tool,
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
                    "workflow, forms, settings), and when done stop calling tools and "
                    "emit a 3-5 sentence summary handoff."
                )
            ),
        ]

        # ---- ReAct loop ----
        orientation = ""
        step_budget_exhausted = False
        final_response: AIMessage | None = None

        for step in range(max_steps):
            response: AIMessage = await model.ainvoke(messages)
            messages.append(response)

            text_blocks = _extract_text_blocks(response)
            tool_calls = getattr(response, "tool_calls", None) or []

            # Record each text block as its own thought entry. We attach
            # all text blocks that appeared in this AIMessage; the
            # position in `entries` reflects the step order.
            for text in text_blocks:
                entries.append(TranscriptEntry(kind="thought", text=text))

            if not tool_calls:
                # Natural stop: the LLM decided it was done. Use the
                # combined text blocks as the orientation handoff.
                final_response = response
                orientation = "\n\n".join(text_blocks)
                chat_log(
                    "info",
                    "research_codebase_loop_done",
                    step=step,
                    repo=repo_full_name,
                    orientation_chars=len(orientation),
                )
                break

            # Execute each requested tool; record each call + result
            # both as a transcript entry and as a ToolMessage the LLM
            # sees on the next turn.
            for tool_call in tool_calls:
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

                entries.append(
                    TranscriptEntry(
                        kind="tool_call",
                        tool=name,
                        args=dict(args) if isinstance(args, dict) else {"raw": args},
                        result=result,
                    )
                )
                messages.append(
                    ToolMessage(
                        content=json.dumps(result, default=str),
                        tool_call_id=tool_call["id"],
                        name=name,
                    )
                )
        else:
            step_budget_exhausted = True
            chat_log(
                "warn",
                "research_codebase_step_budget_exhausted",
                max_steps=max_steps,
                repo=repo_full_name,
            )

        # Even on step-budget exhaustion, the last AIMessage that was
        # seen may carry useful orientation text. Prefer the natural
        # break's text; fall back to nothing if we never got a clean
        # stop.
        if final_response is None and step_budget_exhausted:
            orientation = (
                f"Codebase exploration stopped after reaching the step budget "
                f"({max_steps} steps) before producing a clean summary. Partial "
                "evidence is available in the transcript below."
            )

        chat_log(
            "info",
            "research_codebase_transcript_built",
            repo=repo_full_name,
            entries_count=len(entries),
            tool_calls=sum(1 for e in entries if e.kind == "tool_call"),
            thoughts=sum(1 for e in entries if e.kind == "thought"),
            file_reads=sum(
                1
                for e in entries
                if e.kind == "tool_call" and e.tool == "get_file_content"
            ),
            step_budget_exhausted=step_budget_exhausted,
            orientation_chars=len(orientation),
            tree_truncated=tree_truncated,
            tree_warning_count=len(tree_warnings),
        )

        return CodebaseTranscript(
            repo_full_name=repo_full_name,
            default_branch=cached_branch,
            path_count=len(cached_paths or []),
            tree_truncated=tree_truncated,
            tree_warnings=tree_warnings,
            orientation=orientation,
            entries=entries,
            step_budget_exhausted=step_budget_exhausted,
        )
