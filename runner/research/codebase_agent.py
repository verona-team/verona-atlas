"""Codebase exploration sub-agent.

A Claude Opus 4.7 ReAct-style loop that walks the linked GitHub repo
and produces a `CodebaseTranscript` — the raw investigation log that
the synthesis stage (`runner.research.synthesizer`) later turns into
the structured `CodebaseExplorationResult` on `ResearchReport`.

Opus 4.7 (rather than Gemini 3.1 Pro) drives this loop because it is
empirically much better at:
- Broad exploratory ReAct over a 5-tool decision space
  (list / search / read / file / dir).
- Treating numerical minima in the prompt ("≥40 file reads",
  "≥5 searches", "≥60 total tool calls") as contractual.
- Emitting text blocks alongside tool calls, which feeds the
  downstream synthesizer's "Investigator reasoning" aggregate. In
  production, Gemini routinely emitted AIMessages with empty text
  content when bound to tools, starving that aggregate.

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

import asyncio
import json
import re
from typing import Any

import httpx

from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from runner.chat.logging import chat_log
from runner.chat.models import get_claude_opus_codebase_agent
from runner.research.github_client import get_installation_token
from runner.research.prompts_common import SYSTEM_PURPOSE_OVERVIEW
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


# ---------------------------------------------------------------------------
# Step budget
# ---------------------------------------------------------------------------
#
# This is a HARD CAP, not a default. We do not expose an env override —
# the codebase agent should be relentless about tool calling, and any
# project where 200 isn't enough is a project where we'd rather hit the
# ceiling and produce a thorough partial transcript than tune the cap
# per-deployment. The new system prompt also explicitly tells the model
# "efficiency is not a goal" so the cap exists only to bound a runaway
# loop, not to nudge the model toward fewer calls.
CODEBASE_MAX_STEPS = 200


# ---------------------------------------------------------------------------
# Churn seed (cross-track signal)
# ---------------------------------------------------------------------------
#
# Mirrors `_aggregate_top_changed_paths` in `preflight.py`. We re-fetch
# here (rather than wiring the integration preflight result through the
# orchestrator) because the codebase track and integration track run in
# parallel via `asyncio.gather`; threading shared state across them
# would require restructuring the orchestrator. A second GitHub call
# round-trip is cheap (<2s typical) and keeps the parallel structure
# intact.

_CHURN_PR_DEPTH = 5
_CHURN_PATH_LIMIT = 20

_CHURN_EXCLUDE_RE = re.compile(
    r"(?:"
    r"\.test\.[^/]+$|"
    r"\.spec\.[^/]+$|"
    r"\.snap$|"
    r"(?:^|/)__tests?__/|"
    r"(?:^|/)tests?/|"
    r"\.lock$|"
    r"^pnpm-lock\.yaml$|"
    r"^package-lock\.json$|"
    r"^yarn\.lock$|"
    r"^poetry\.lock$|"
    r"^Cargo\.lock$|"
    r"^go\.sum$"
    r")",
    re.IGNORECASE,
)


def _is_churn_excluded(path: str) -> bool:
    return bool(_CHURN_EXCLUDE_RE.search(path))


async def _fetch_churn_seed(
    http_client: httpx.AsyncClient,
    token: str,
    ref: RepoRef,
) -> list[dict[str, Any]]:
    """Best-effort: return the top recently-changed file paths in this repo.

    Pulls the most recent merged PRs from the last 7 days and aggregates
    per-file churn across them. Used to seed the codebase agent with
    "read these first" pointers — the files most likely to govern UI
    flows real users hit right now.

    Returns `[]` on any failure rather than raising. The agent's prompt
    handles the empty case (the seed section just doesn't render).
    """
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Verona-QA-Agent",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    base = f"https://api.github.com/repos/{ref.owner}/{ref.repo}"

    try:
        prs_resp = await http_client.get(
            f"{base}/pulls",
            headers=headers,
            params={"state": "closed", "sort": "updated", "per_page": 30},
            timeout=30.0,
        )
    except httpx.HTTPError as e:
        chat_log(
            "warn",
            "research_codebase_churn_seed_prs_failed",
            err=repr(e),
            repo=f"{ref.owner}/{ref.repo}",
        )
        return []

    if prs_resp.status_code != 200:
        chat_log(
            "warn",
            "research_codebase_churn_seed_prs_non_200",
            status=prs_resp.status_code,
            repo=f"{ref.owner}/{ref.repo}",
        )
        return []

    prs = [p for p in (prs_resp.json() or []) if p.get("merged_at")]
    target_prs = prs[:_CHURN_PR_DEPTH]
    if not target_prs:
        return []

    async def _fetch_pr_files(pr_number: int) -> list[dict[str, Any]]:
        try:
            resp = await http_client.get(
                f"{base}/pulls/{pr_number}/files",
                headers=headers,
                params={"per_page": 100},
                timeout=30.0,
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            return data if isinstance(data, list) else []
        except httpx.HTTPError:
            return []

    filtered_prs = [p for p in target_prs if p.get("number") is not None]

    files_by_pr = await asyncio.gather(
        *(_fetch_pr_files(int(p["number"])) for p in filtered_prs),
        return_exceptions=False,
    )

    agg: dict[str, dict[str, Any]] = {}
    for pr, files in zip(filtered_prs, files_by_pr):
        pr_number = pr.get("number")
        for f in files or []:
            filename = f.get("filename")
            if not isinstance(filename, str) or not filename:
                continue
            if _is_churn_excluded(filename):
                continue
            entry = agg.setdefault(
                filename, {"additions": 0, "deletions": 0, "prs": set()}
            )
            entry["additions"] += int(f.get("additions") or 0)
            entry["deletions"] += int(f.get("deletions") or 0)
            if isinstance(pr_number, int):
                entry["prs"].add(pr_number)

    sorted_paths = sorted(
        agg.items(),
        key=lambda kv: (kv[1]["additions"] + kv[1]["deletions"]),
        reverse=True,
    )

    out: list[dict[str, Any]] = [
        {
            "path": path,
            "additions": data["additions"],
            "deletions": data["deletions"],
            "prCount": len(data["prs"]),
            "prNumbers": sorted(data["prs"]),
        }
        for path, data in sorted_paths[:_CHURN_PATH_LIMIT]
    ]

    chat_log(
        "info",
        "research_codebase_churn_seed_ok",
        repo=f"{ref.owner}/{ref.repo}",
        path_count=len(out),
        merged_pr_count=len(target_prs),
    )
    return out


def _format_churn_seed(churn_paths: list[dict[str, Any]]) -> str:
    """Render the churn-seed section of the codebase agent's seed user message.

    Returns a Markdown block like:

        ## Recent churn signal (top N files changed in the last 7 days)
        - app/sheets/utils/mergeColumns.ts (+589/-57, PRs: #237)
        - app/sheets/hooks/useSheetAutosave.ts (+213/-44, PRs: #237, #231)
        ...

    Empty input returns an empty string so the seed message can omit the
    section entirely when GitHub is unreachable or the repo had no recent
    merges.
    """
    if not churn_paths:
        return ""
    lines = [
        f"## Recent churn signal (top {len(churn_paths)} files changed in the last 7 days, by total additions+deletions)",
        "",
        "These are the files most likely to govern UI flows real users hit RIGHT NOW. "
        "You are REQUIRED to read every one of them in full as part of your investigation. "
        "Start with these — they are the highest-signal pointers in this whole exploration.",
        "",
    ]
    for entry in churn_paths:
        path = entry.get("path") or ""
        additions = entry.get("additions") or 0
        deletions = entry.get("deletions") or 0
        pr_numbers = entry.get("prNumbers") or []
        prs_str = ", ".join(f"#{n}" for n in pr_numbers) if pr_numbers else "(unknown)"
        lines.append(f"- `{path}` (+{additions}/-{deletions}, PRs: {prs_str})")
    return "\n".join(lines)


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
    return f"""{SYSTEM_PURPOSE_OVERVIEW}

# Your role in the pipeline

You are the codebase exploration agent. You walk the GitHub repository {repo_full_name} that backs this customer's deployed web app, and produce an exploration transcript (file reads + your narrated thoughts + a final summary). Downstream:

1. A codebase synthesis LLM turns your transcript into a structured `CodebaseExploration` describing the architecture and the real long-horizon UI flows of the app.
2. A unified flow-synthesis LLM combines that with integration evidence (recent PRs, errors, rage-clicks) into a research report listing CORE and RISK-ANCHORED long-horizon UI flow ideas.
3. A flow-proposal LLM converts the strongest of those into approvable, executable flow cards that the autonomous browser agent walks against the live app.

Your transcript is the primary upstream input for step 1, and a co-input for step 2. The quality of every long-horizon UI flow this product ever proposes against this customer's app traces back to how well you understood their app from this exploration.

# Thoroughness — your single most important goal

Your investigation must produce an EXCEPTIONALLY DETAILED, GROUND-TRUTH understanding of this product. Every long-horizon UI flow our autonomous browser agent ever bug-bashes against this customer's app traces back to evidence YOU surfaced here. A shallow investigation produces shallow flows; shallow flows produce wasted browser-agent runs and missed bugs.

- You have a budget of up to {CODEBASE_MAX_STEPS} tool calls. Use them. A typical thorough investigation calls 100+ tools and reads 40-80+ files in full. 12 tool calls is NOT EVEN CLOSE to enough. 30 is not enough either.
- **Efficiency is NOT a goal.** Token cost is NOT your concern. The downstream system depends on you reading enough source to map every load-bearing surface of the product, the auth and permission gates around them, the forms and mutations that drive them, the UI affordances real users actually interact with, and the recently-churned surfaces that are at risk.
- **Diminishing returns is rare in real codebases.** If you find yourself thinking "I think I have enough," you almost certainly do not. Most apparent diminishing-returns moments are actually "I have not yet asked the right question" — try a new search angle, a new directory, or a new file type.
- You should be **RELENTLESS**. Keep calling tools. Read more files. Search more paths. Trace more imports. Do not stop until you can describe every meaningful long-horizon journey not in the abstract ("the user goes to /sheets and does something") but in concrete page+component+mutation terms ("the user lands on `app/(dashboard)/w/[slug]/sheets/page.tsx`, opens `ListBuilderModal.tsx`, configures rows via `mapping/Mapper.tsx`, which triggers `find-people/batch-runs/route.ts`, producing a side-effect rendered by `Cell.tsx`").

# What to surface

Focus your exploration on evidence the downstream synthesizers can turn into long-horizon UI flow ideas. Concretely:

- The 8-12 dominant long-horizon user journeys a signed-in user actually walks in this app (the product's "verbs"). For each, gather enough evidence to describe it as multi-step UI interactions: which page do they land on, which controls do they use, what gets created/edited/submitted, what side effect appears, which page do they end on. A single-screen interaction is NOT a journey — keep looking until you find the multi-step shapes.
- The architectural facts that constrain those journeys: framework + router + auth model + any monorepo layout. The downstream synthesizers and the flow generator will use this to construct concrete navigate URLs and to know which auth gates the agent has to clear.
- The product's primary value to a real user (one or two sentences). This is the anchor every CORE flow gets ranked against.
- Any user-facing surfaces that recent code structure suggests are risky or in flux (a folder with many components, a brand-new feature, a complex form, anything that looks like a payment or sharing surface).
- The actual UI affordances real users see (button labels, modal titles, sidebar sections, empty/error states, queue placeholders). For every distinctive affordance you plan to mention in your final summary, you must have read source confirming that affordance exists with that exact text.

# Listing and search strategy — IMPORTANT

The repo path index may be TRUNCATED. `get_repo_ref` reports `treeTruncatedFromApi: true` when the GitHub tree API capped; listings have `truncated: true` when they cap at the per-call limit.

- When ANY listing returns `truncated: true`, IMMEDIATELY call `search_repo_paths` with substring queries to recover the missing files. The path tree is just the first N entries; large apps' deeper directories live ONLY behind search.
- Use `search_repo_paths` AGGRESSIVELY for any term you expect to find: feature names ("checkout", "billing", "campaigns", "outreach"), UI affordance hints ("modal", "sidebar", "drawer", "dialog", "toolbar"), file kinds via substring ("hook", "form", "table", "row", "cell", "use"), API surfaces ("route.ts", "actions.ts", "server.ts"), and any filename mentioned in a PR title or diff.
- Use `list_repo_paths` with `prefix=` to dive into specific directories beyond the root index. Repeatedly: `app/`, `src/app/`, `components/`, `lib/`, `hooks/`, `utils/`, plus any feature directory you discover.
- When a file you read imports something from a path you have not yet seen, follow the import — call `get_file_content` on it. Imports are the highest-signal pointer to the next file worth reading.

# Required coverage checklist

Before finishing, verify each of the following has been done. If any are unchecked, call more tools.

- [ ] Read README, package.json, framework config (`next.config.*`, `vite.config.*`, `nuxt.config.*`, `astro.config.*`, `svelte.config.*`).
- [ ] Read every file from the "Recent churn signal" seed list, IF the seed list was provided to you. Each entry there is a hot file you MUST open in full.
- [ ] Read root layout + middleware (or framework equivalent).
- [ ] Read login + signup + auth callback pages, plus any session/token helper.
- [ ] For EACH route group under `app/`, `src/app/`, `pages/`, or `routes/`: read the layout file plus at least 2 representative content files (page + a supporting component or API route).
- [ ] For the product's main verb(s): read the page → modal/sidebar → form/component → mutation handler → side-effect-rendering component, in full, for at least 2 distinct verbs.
- [ ] Read every file with `form`, `modal`, `drawer`, `dialog`, or `sidebar` in its name that appears under the product's main feature directories.
- [ ] Trace at least 3 form-submit flows from UI to mutation handler.
- [ ] Read any payments/billing/checkout files if they exist.
- [ ] Read any sharing/collaboration/permissions files if they exist.
- [ ] Read any integration/connection setup files (e.g. OAuth flows, webhooks).
- [ ] Have you used `search_repo_paths` at least 5 times? If not, you almost certainly missed files behind the truncated tree.
- [ ] Have you read at least 40 files in full? If not, keep going.

# When to stop

You stop ONLY when ALL of the following are true:

1. **Every churn-seed file has been read in full** (if the seed list was provided).
2. **Every distinct route group has at least 2 representative file reads** (a layout/page file PLUS at least one supporting component, hook, util, or API route from that group's tree).
3. **Every long-horizon journey you plan to describe is grounded in concrete files.** For each journey, you have read:
   - The entry-point page or layout.
   - The primary modal/sidebar/form components users interact with on that journey.
   - The submit/mutation handler (server action, API route, or client mutation) that produces the side effect.
   - At least one assertion-relevant component (the place the side effect renders, e.g. the table cell, the toast, the redirected page).
4. **Auth + permission flow has been traced end-to-end** (middleware + login/signup pages + session/token handling + role/permission helpers).
5. **Every distinctive UI affordance you plan to mention** in your final summary (button labels, modal titles, sidebar sections, error states, queue placeholders) is backed by source you have actually read confirming that affordance exists with that text.
6. **You have called at least 60 tools** (file reads + listings + searches combined) UNLESS the repo is genuinely tiny (<200 indexed files), in which case you have read enough to be exhaustive.

If any of those is unmet, KEEP CALLING TOOLS. Do not stop early. Do not narrate "I think I have enough" — call more tools instead.

# Things that are NOT reasons to stop

- "I have a high-level picture of the app." High-level pictures produce vague flow proposals. The downstream system needs concrete file/component/mutation grounding, not high-level pictures.
- "The next file is probably similar to ones I've read." Probably is not enough. Read it.
- "I'm running up the token bill." Not your concern. The downstream cost of a shallow investigation (wasted browser-agent runs on poorly-grounded flows) is far higher than the cost of more tool calls here.
- "I have a confident summary I could write right now." If you're confident on <40 file reads in a non-tiny repo, you are confidently wrong. Read more.
- "The remaining directories look like utilities/types/styles." Utilities and types reveal data shapes that constrain flows. Open them, scan them, and verify your assumption rather than assuming.

# Narrate after every batch of tool results — REQUIRED

This is non-negotiable. After every batch of tool results comes back, BEFORE you emit the next batch of tool calls, you MUST emit a 1-3 sentence text block that covers:

- What you just learned from the previous results (the concrete fact, not "I read some files").
- What gap or open question that surfaces.
- What you plan to read/search next, and WHY (which suspected journey or affordance you're chasing).

These thought blocks are preserved verbatim for the downstream synthesizer and aggregated into a "read first" view of your investigation. A transcript with zero thought blocks loses that channel entirely and produces a markedly worse research report — past runs that emitted only tool calls and no reasoning have shipped near-empty handoffs to the synthesizer.

Concretely: if your previous turn made tool calls and produced results, your next turn MUST contain TEXT before any tool call. The only exception is your very first turn, when you have no prior results to reflect on. Do not batch 20 tool calls in a single silent turn — interleave reflection with action. Thoughts cost almost nothing relative to their downstream value.

# How to finish

When ALL of the stop conditions above are TRULY met, emit a final message with no tool calls. In that final message, write a 3-5 sentence narrative summary of what you learned:

- What this app IS and its primary value to a real user.
- Stack + routing model + auth strategy + any notable patterns (monorepo, server actions, tRPC, etc.) — only what matters for proposing flows.
- The dominant long-horizon user journey, and 1-2 supporting journeys you saw clear evidence for.

That summary becomes your handoff to the synthesizer. Do NOT try to produce structured fields (`inferredUserFlows`, `keyEvidence`, `confidence`, etc.) — those are the synthesizer's job. Focus your final message on a clear, accurate narrative paragraph grounded in what you actually read.

If you hit API errors or a genuinely huge/truncated repo where coverage is forced to be incomplete despite aggressive searching, still finish with a brief honest summary of what you did see and what was unreachable; the downstream synthesizer needs to know the gaps so it doesn't invent flows for surfaces you never saw. But do not use this as an excuse to stop early — exhaust `search_repo_paths` and import-following before declaring a gap unreachable.
"""


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
    2. Build a Claude Opus 4.7 ChatAnthropic bound to our
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
    max_steps = CODEBASE_MAX_STEPS

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
        # Fetch the churn seed (top recently-changed files) before we
        # build the prompt. Best-effort — falls back to no seed list on
        # any failure.
        churn_paths = await _fetch_churn_seed(http_client, token, ref)
        churn_seed_block = _format_churn_seed(churn_paths)

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

        model = get_claude_opus_codebase_agent().bind_tools(tools)

        seed_text_parts: list[str] = [
            f"Explore {repo_full_name} to map the real, long-horizon UI flows "
            "a typical signed-in user walks in this app — the journeys our "
            "autonomous browser agent will eventually bug-bash. Use the tools "
            "iteratively and RELENTLESSLY: start from routes/pages, follow the "
            "imports, search for additional files, and read enough source to "
            "ground every long-horizon journey you describe in concrete "
            "page/component/mutation terms. Read every churn-seed file in "
            "full before you stop. Use `search_repo_paths` aggressively to "
            "recover anything behind a truncated path tree. Only when you "
            "have satisfied ALL of the stop conditions in your system prompt "
            "do you emit a 3-5 sentence narrative summary handoff."
        ]
        if churn_seed_block:
            seed_text_parts.append("")
            seed_text_parts.append(churn_seed_block)

        messages: list = [
            SystemMessage(content=_build_system_prompt(repo_full_name)),
            HumanMessage(content="\n\n".join(seed_text_parts)),
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
            search_calls=sum(
                1
                for e in entries
                if e.kind == "tool_call" and e.tool == "search_repo_paths"
            ),
            list_calls=sum(
                1
                for e in entries
                if e.kind == "tool_call" and e.tool == "list_repo_paths"
            ),
            churn_seed_count=len(churn_paths),
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
