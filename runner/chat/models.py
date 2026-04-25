"""Central factory for chat models used across the runner.

All LLM calls from the Modal runner MUST go through these helpers so that:

- Model selection (Gemini Pro vs Gemini Flash vs Claude Opus) is consistent
  and documented.
- `max_tokens` / `timeout` / `max_retries` are set in one place.
- LangSmith tracing picks up every call uniformly via the native
  `langchain-google-genai` / `langchain-anthropic` integrations.

## Model selection rules

- **Gemini 3.1 Pro** (`gemini-3.1-pro-preview`) is used for the main
  reasoning workloads that stay on Google: chat orchestrator,
  integration-research orchestrator, codebase exploration agent,
  research synthesis (codebase exploration + flow synthesis), and
  flow-proposal generator.

- **Gemini 3 Flash** (`gemini-3-flash-preview`) is the workhorse for the
  lighter-weight, well-scoped summarization tasks: rolling-context
  compaction and the post-run Slack executive summary.

- **Claude Opus 4.7** (`claude-opus-4-7`, via Anthropic) drives two
  separate workloads:

  1. The outer QA test-executor ReAct loop inside `execute_test_run` —
     the agent that observes screenshots, reasons about page state,
     and decides which of our `browser_action` / `navigate_to_url` /
     `observe_dom` / `check_email` / `save_credentials` /
     `complete_test` tools to call next. Opus 4.7 is the current
     Anthropic flagship for agentic tool use and screenshot reasoning
     and does NOT collide with the Stagehand CUA `computer_20250124`
     issue because this layer uses our own custom tool schema, not
     Anthropic's native computer-use tool. Exposed via
     `get_claude_opus_outer()`.

  2. The integration-research code writer inside
     `runner.research.code_writer`, which translates a
     natural-language research goal into a focused Python httpx
     script for the Modal sandbox. We pin code generation to Opus 4.7
     because it produces noticeably more correct provider-API code
     (defensive `.get()` access, proper auth headers, bounded result
     slicing) than Gemini did in practice — fewer wasted sandbox
     execs from KeyError tracebacks or oversized stdout. The
     orchestrator that decides WHAT to investigate stays on Gemini
     3.1 Pro; only the script-writing role uses Opus. Exposed via
     `get_claude_opus_code_writer()`.

- **Claude Opus 4.6** (`claude-opus-4-6`, via Anthropic) is used ONLY for
  the Stagehand browser agent (session + inner execute agent). Stagehand's
  CUA mode is currently tuned for Claude-family models, and Stagehand v3's
  supported CUA-model list
  (https://docs.stagehand.dev/v3/configuration/models) tops out at Opus 4.6
  — the SDK still emits the legacy `computer_20250124` tool schema, which
  Opus 4.7 refuses. The model id is defined in `runner/prompts.py` because
  the Stagehand SDK wants the raw `provider/model-id` string, not a
  LangChain `BaseChatModel`. `get_claude_opus()` below returns a LangChain
  wrapper around this same 4.6 id for any future non-Stagehand, CUA-adjacent
  path that wants to run on the same model as the inner browser agent.

If a future task needs something even stronger or a new provider, add a
helper here and keep the call sites declarative (`get_gemini_pro()` /
`get_gemini_flash()` / `get_claude_opus()` / `get_claude_opus_outer()`),
not model-name-sprinkled.

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
    """Gemini 3.1 Pro — the main Google-side reasoning model.

    Used for the chat orchestrator, research orchestrator, research code
    writer, codebase explorer, and flow-proposal generator. The outer QA
    test-executor ReAct loop lives on Anthropic Opus 4.7 via
    `get_claude_opus_outer()` instead.

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
