"""Central factory for chat models used across the runner.

All LLM calls from the Modal runner MUST go through these helpers so that:

- Model selection (Gemini Pro vs Gemini Flash vs Claude Opus) is consistent
  and documented.
- `max_tokens` / `timeout` / `max_retries` are set in one place.
- LangSmith tracing picks up every call uniformly via the native
  `langchain-google-genai` / `langchain-anthropic` integrations.

## Model selection rules

The pipeline splits responsibilities along the line between **agentic /
exploratory tool use** (Anthropic Opus 4.7) and **summarization +
structured output over long context** (Gemini 3.1 Pro / 3 Flash).

- **Claude Opus 4.7** (`claude-opus-4-7`, via Anthropic) drives every
  agentic / tool-use surface in the runner. Opus is empirically much
  better than Gemini at relentless ReAct loops, narrating reasoning
  between tool calls (which our codebase-exploration → synthesis
  pipeline depends on for the "Investigator reasoning" aggregate), and
  treating numerical minima in prompts as contractual rather than
  aspirational. Five distinct workloads:

  1. The outer QA test-executor ReAct loop inside `execute_test_run`
     (`get_claude_opus_outer()`). Drives `browser_action` /
     `navigate_to_url` / `observe_dom` / `click_selector` /
     `fill_selector` / etc. Does NOT collide with Stagehand's CUA
     `computer_20250124` issue because this layer uses our own custom
     tool schema, not Anthropic's native computer-use tool.

  2. The integration-research code writer
     (`get_claude_opus_code_writer()`). Translates a natural-language
     research goal into a focused Python httpx script for the Modal
     sandbox. Empirically produces more correct provider-API code
     (defensive `.get()` access, proper auth headers, bounded result
     slicing) than Gemini, which directly translates to fewer wasted
     sandbox execs.

  3. The codebase exploration agent
     (`get_claude_opus_codebase_agent()`). Walks the linked GitHub
     repo via `get_repo_ref` / `list_repo_paths` /
     `search_repo_paths` / `get_file_content` over up to 200 tool
     calls per run. Opus is significantly better than Gemini at
     broad exploratory ReAct (file reads + import-following + search
     recovery from 404s) and at narrating reasoning between tool
     calls.

  4. The integration research orchestrator
     (`get_claude_opus_integration_orchestrator()`). Decides what to
     investigate across connected providers via natural-language
     `purpose` strings to `execute_code`. Same broad-exploration
     advantage as the codebase agent.

  5. The unified flow synthesizer
     (`get_claude_opus_flow_synthesis()`). Reads BOTH research
     transcripts (codebase + integration) and emits the structured
     `FlowSynthOutput` (CORE flows + RISK-ANCHORED flows + findings
     + drillInHighlights). Opus 4.7's 1M-token input window
     comfortably absorbs the combined rendered transcripts at the
     shared 300K-per-track soft cap, so no special context handling
     is needed at this call site.

- **Gemini 3.1 Pro** (`gemini-3.1-pro-preview`) is used where the task
  is summarization or structured output over a LONG transcript that
  would not fit comfortably under Opus's 200K input cap. Two
  workloads:

  1. The chat orchestrator agent_turn (`runner/chat/nodes.py`) — the
     LLM the user "talks to" in the chat UI. High request volume,
     latency-sensitive, modest context.

  2. The codebase-exploration synthesis call
     (`runner.research.synthesizer.generate_codebase_exploration`).
     This single LLM call reads the entire codebase transcript
     (which can exceed 300K tokens after a thorough Opus-driven
     investigation) and emits a structured `CodebaseExploration`.
     Gemini's 1M+ context window is the right tool here.

  3. The flow-proposal generator (`runner.chat.flow_generator`). Emits
     the 1–3 approval-card flow objects via Gemini's JSON-schema
     structured-output mode.

- **Gemini 3 Flash** (`gemini-3-flash-preview`) is the workhorse for
  the light, well-scoped summarization tasks: rolling-context
  compaction (`runner.chat.context`), the post-run Slack executive
  summary (`runner.reporter`), and short UX copy when a test run is
  kicked off (`runner.chat.nodes._run_kicked_off_copy`).

- **Claude Opus 4.6** (`claude-opus-4-6`, via Anthropic) is used ONLY
  for the Stagehand browser agent (session + inner execute agent).
  Stagehand v3's supported CUA-model list tops out at Opus 4.6 — the
  SDK still emits the legacy `computer_20250124` tool schema, which
  Opus 4.7 refuses. The model id is defined in `runner/prompts.py`
  because the Stagehand SDK wants the raw `provider/model-id` string,
  not a LangChain `BaseChatModel`. `get_claude_opus()` below returns
  a LangChain wrapper around this same 4.6 id for any future
  non-Stagehand path that wants to run on the inner browser agent's
  model.

If a future task needs something different, add a helper here and
keep the call sites declarative (`get_gemini_pro()` /
`get_gemini_flash()` / `get_claude_opus()` /
`get_claude_opus_outer()` / `get_claude_opus_code_writer()` /
`get_claude_opus_codebase_agent()` /
`get_claude_opus_integration_orchestrator()` /
`get_claude_opus_flow_synthesis()`), not model-name-sprinkled.

## A note on temperature

Per the `langchain-google-genai` docs, Gemini 3.0+ defaults to
`temperature=1.0`. Passing a low temperature (e.g. `0.1`) to a Gemini 3
model can cause infinite loops, degraded reasoning, and outright failures
on complex tasks. For that reason these helpers default to NOT setting
`temperature` at all, letting the library apply the model-appropriate
default. Override explicitly only when you have a reason.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from langchain_anthropic import ChatAnthropic
    from langchain_google_genai import ChatGoogleGenerativeAI


# Model ids — kept as module-level constants so tests can patch a single
# place if they want to hit a cheaper / different model.
GEMINI_PRO_MODEL = "gemini-3.1-pro-preview"
GEMINI_FLASH_MODEL = "gemini-3-flash-preview"
CLAUDE_OPUS_MODEL = "claude-opus-4-6"
CLAUDE_OPUS_OUTER_MODEL = "claude-opus-4-7"


def get_gemini_pro(
    *,
    max_tokens: int | None = 66_000,
    temperature: float | None = None,
    timeout: float | None = 300.0,
    max_retries: int = 2,
) -> "ChatGoogleGenerativeAI":
    """Gemini 3.1 Pro — Google-side reasoning model for long-context tasks.

    Used for the chat orchestrator (`runner.chat.nodes`), the
    codebase-exploration synthesizer
    (`runner.research.synthesizer.generate_codebase_exploration`), and
    the flow-proposal generator (`runner.chat.flow_generator`). The
    research-side agentic loops (codebase exploration agent +
    integration research orchestrator) and the unified flow
    synthesizer all live on Anthropic Opus 4.7 — see the helpers
    further down this module.

    Defaults are set to the model's full envelope rather than a
    conservative fraction of it:

    - `max_tokens=66_000` matches Gemini 3.1 Pro's maximum output token
      ceiling. Reasoning models burn output tokens on thinking blocks
      BEFORE they emit the final answer, so a cap below the model's
      ceiling silently truncates structured output when a turn reasons
      hard (e.g. codebase agent reading 6 files + drafting a finish
      payload). Better to let the model self-terminate than to clip it.
    - `timeout=300.0` (5 minutes) gives reasoning + tool-use turns room
      to breathe. A chat orchestrator turn that fires
      `generate_flow_proposals` can internally take a minute or two
      end-to-end on a cold research cache.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI

    kwargs: dict[str, Any] = {
        "model": GEMINI_PRO_MODEL,
        "max_retries": max_retries,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if temperature is not None:
        kwargs["temperature"] = temperature
    if timeout is not None:
        kwargs["timeout"] = timeout
    return ChatGoogleGenerativeAI(**kwargs)


def get_gemini_flash(
    *,
    max_tokens: int | None = 66_000,
    temperature: float | None = None,
    timeout: float | None = 180.0,
    max_retries: int = 2,
) -> "ChatGoogleGenerativeAI":
    """Gemini 3 Flash — the cheap/fast summarization model.

    Used for rolling conversation-context compaction and the post-test-run
    Slack executive summary. These are short, well-scoped tasks where we
    want throughput and cost, not peak reasoning.

    `max_tokens=66_000` matches Gemini 3 Flash's maximum output ceiling.
    Summaries are almost always far shorter than this, but the ceiling is
    the safe default — specific call sites that want to hard-cap output
    for UI/prose-length reasons should still pass their own `max_tokens`.

    `timeout=180.0` (3 minutes) is plenty for the summarization workloads
    Flash handles; it isn't a reasoning model so it doesn't need the
    Pro/Opus 5-minute budget.
    """
    from langchain_google_genai import ChatGoogleGenerativeAI

    kwargs: dict[str, Any] = {
        "model": GEMINI_FLASH_MODEL,
        "max_retries": max_retries,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if temperature is not None:
        kwargs["temperature"] = temperature
    if timeout is not None:
        kwargs["timeout"] = timeout
    return ChatGoogleGenerativeAI(**kwargs)


def get_claude_opus(
    *,
    max_tokens: int = 128_000,
    temperature: float = 0.2,
    timeout: float = 300.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.6 — reserved for the Stagehand browser agent path.

    The Stagehand SDK consumes this model via its own agent/session config
    (see `runner/prompts.py` + `runner/browser.py`) which speaks directly
    to the Anthropic API. This helper exists so any future non-Stagehand
    LangChain path that needs Opus can get a configured `ChatAnthropic`
    without re-pinning the model id.

    `max_tokens=128_000` matches Opus 4.6's maximum output ceiling;
    `timeout=300.0` (5 minutes) matches the Gemini Pro reasoning budget.
    Both are the safe defaults for any non-Stagehand Opus call we might
    add later — override downward on specific call sites if you need
    shorter outputs for UI/token-budget reasons.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_claude_opus_code_writer(
    *,
    max_tokens: int = 128_000,
    timeout: float = 300.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — the integration-research code writer.

    Generates Python httpx scripts for the Modal sandbox in
    `runner.research.code_writer.write_research_code`. Each call is
    stateless and bounded: input is one research `purpose` string +
    provider docs + env-var catalog (+ optional previous-exec summary
    for self-correction); output is a `{code, explanation}` structured
    object filled via Anthropic's structured-output tool-call shim.

    Defaults rationale:

    - `max_tokens=128_000`: matches Opus 4.7's full output ceiling.
      Reasoning models burn output tokens on adaptive-thinking blocks
      BEFORE they emit the final structured `{code, explanation}` —
      a cap below the model's ceiling silently truncates the schema
      response when a turn reasons hard (large pagination loop,
      complex HogQL, multi-pass self-correction off a previous_exec
      failure). Better to let the model self-terminate than to clip
      it. Same envelope rationale as `get_gemini_pro` / Stagehand
      Opus elsewhere in the runner.
    - `timeout=300.0` (5 minutes): matches the reasoning-model budget
      the rest of the runner uses (`get_gemini_pro`,
      `get_claude_opus_outer`). A code-writer turn that reasons hard
      against the previous exec's stderr — figuring out the right
      pagination param, the right field name to `.get()`, etc. — can
      legitimately take a minute or two on Anthropic's API; 5 min
      lets the slow-tail land instead of timing out into the
      error-stub fallback.
    - **No `temperature` kwarg:** Opus 4.7 does not accept `temperature`
      (`langchain-anthropic` model profile `"temperature": False`).
      Setting it raises at request time.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_OUTER_MODEL,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_claude_opus_codebase_agent(
    *,
    max_tokens: int = 32_000,
    timeout: float = 300.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — the codebase exploration ReAct agent.

    Drives `runner.research.codebase_agent.run_codebase_exploration_transcript`.
    The agent walks the linked GitHub repo via `get_repo_ref`,
    `list_repo_paths`, `search_repo_paths`, `get_file_content`, and
    `suggest_important_paths` with a hard 200-step ceiling and an
    explicit "thoroughness is your single most important goal" prompt.

    Why Opus 4.7 here instead of Gemini:

    - Empirically much better at broad, exploratory ReAct loops
      (file reads + import-following + search recovery) where the
      decision tree is wide. Gemini was observed stopping at 21
      tool calls in production despite the prompt's explicit
      ≥60-tool floor.
    - Reliably emits text blocks alongside tool calls — the
      "narrate as you go" directive in the prompt is what feeds
      the synthesizer's "Investigator reasoning" aggregate.
      Gemini routinely returned AIMessages with empty text content
      when bound to tools, starving that aggregate.
    - Treats numerical minima ("≥40 file reads", "≥5 searches") as
      contractual rather than aspirational.

    Defaults rationale:

    - `max_tokens=32_000`: per-turn output cap. A single ReAct turn
      typically emits a short narration block + one or two tool
      calls; 32k gives adaptive thinking plenty of room without
      letting a runaway turn burn the budget.
    - `timeout=300.0` (5 minutes): matches the reasoning-model
      budget the rest of the runner uses. A turn that reasons hard
      across many prior tool results before picking the next file
      to read can legitimately take a minute or two.
    - **No `temperature` kwarg:** Opus 4.7 does not accept
      `temperature` (`langchain-anthropic` model profile
      `"temperature": False`). Setting it raises at request time.

    Note on context window: Opus 4.7 has a 1M-token input window,
    which is comfortably larger than the codebase agent's running
    message history will reach. Individual file contents are
    capped by `get_text_file_content` and the agent's path index
    is cached, so per-turn input stays well under that limit even
    on a 100+ tool run.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_OUTER_MODEL,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_claude_opus_integration_orchestrator(
    *,
    max_tokens: int = 32_000,
    timeout: float = 300.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — the integration research orchestrator.

    Drives `runner.research.integration_agent._run_research_loop`. The
    orchestrator decides WHAT to investigate across connected
    providers by issuing natural-language `purpose` strings to its
    single `execute_code` tool; the code-writer (also Opus 4.7) turns
    each purpose into a focused Python script and runs it in a Modal
    sandbox.

    Same Opus-vs-Gemini rationale as `get_claude_opus_codebase_agent`:
    Opus is empirically stronger at multi-step ReAct over a tool with
    a broad decision space (which provider to query next, which
    finding to drill into, when to correlate cross-source) and at
    narrating its reasoning between calls so the synthesizer's
    "Investigator reasoning" aggregate has real content.

    Defaults rationale: same per-turn output cap and timeout as
    `get_claude_opus_codebase_agent`. No `temperature` kwarg per
    Opus 4.7's profile.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_OUTER_MODEL,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_claude_opus_flow_synthesis(
    *,
    max_tokens: int = 32_000,
    timeout: float = 600.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — the unified flow synthesis call.

    Drives `runner.research.synthesizer.generate_flow_report`. This
    single LLM call reads BOTH research transcripts (codebase +
    integration) and emits the structured `FlowSynthOutput` with
    `coreFlows`, `riskFocusedFlows`, `findings`, and
    `drillInHighlights`. It is the most consequential synthesis step
    in the research-to-flows pipeline — every flow our autonomous
    browser agent ever bug-bashes traces back to this call's output.

    Why Opus 4.7 here:

    - The flow synthesizer is the one place where evidence from the
      two ReAct agents (also on Opus 4.7) gets combined into the
      final flow ideas. Keeping the same model family across the
      research → synthesis → flow generation chain reduces
      style/format mismatch and lets us iterate prompts coherently.
    - Anthropic's structured-output reliability (via the
      tool-calling shim that `with_structured_output` uses) is
      strong on multi-section payloads with required fields, which
      matches `FlowSynthOutput`'s shape.
    - In production, Gemini was observed silently dropping
      `keyEvidence` to 0 on rich (147K-token) transcripts —
      `min_length` schema constraints are the right structural fix,
      but model strength on long-context structured generation
      matters too.

    Defaults rationale:

    - `max_tokens=32_000`: full output ceiling for the structured
      response. The flow synthesizer's output is moderately large
      (3 core flows × multi-step prose + 3 risk flows × multi-step
      prose + 4-8 findings + drill-in highlights) and adaptive
      thinking burns through tokens before emitting the structured
      payload — 32k is comfortable.
    - `timeout=600.0` (10 minutes): a flow-synthesis call against a
      ~180K-token combined transcript can take noticeably longer
      than a ReAct-loop per-turn call. The longer ceiling avoids
      tail-timeouts that would surface to the user as a research
      failure.
    - **No `temperature` kwarg:** Opus 4.7's profile.

    Context-window note: Opus 4.7 has a 1M-token input window, so
    the combined rendered input (both transcripts × the shared 300K
    `PER_TRACK_SOFT_TOKEN_CAP` + system prompt + structured-output
    budget) fits comfortably without any special handling at this
    call site.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_OUTER_MODEL,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_claude_opus_outer(
    *,
    max_tokens: int = 32_000,
    timeout: float = 300.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — the outer QA test-executor ReAct loop model.

    Drives the agent inside `runner.test_executor.execute_template` that
    observes browser screenshots, reasons about page state, and picks the
    next tool to call (`browser_action`, `navigate_to_url`, `observe_dom`,
    `check_email`, `save_credentials`, or `complete_test`). Unlike the
    Stagehand inner agent, this layer uses our own tool schema (authored
    in `runner/prompts.py::TOOLS` in Anthropic's native
    `{name, description, input_schema}` shape), so it does NOT collide
    with Stagehand's legacy `computer_20250124` tool-schema issue and can
    safely run on 4.7.

    Defaults rationale:

    - `max_tokens=32_000`: per-turn output cap. Opus 4.7 supports up to
      128k output tokens, but a single ReAct turn in this loop typically
      emits a short natural-language observation + one tool call. 32k
      gives adaptive-thinking plenty of room to reason without letting a
      runaway turn burn our entire budget. Override upward only if you
      observe premature truncation.
    - `timeout=300.0` (5 minutes): matches the reasoning-model budget we
      use everywhere else in the runner. A turn that reasons hard before
      picking a tool can legitimately take over a minute.
    - **No `temperature` kwarg:** Opus 4.7 does not accept `temperature`
      (see `langchain-anthropic` model profile `"temperature": False`).
      Setting it raises at request time.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_OUTER_MODEL,
        max_tokens=max_tokens,
        timeout=timeout,
        max_retries=max_retries,
    )
