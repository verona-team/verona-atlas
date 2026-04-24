"""Central factory for chat models used across the runner.

All LLM calls from the Modal runner MUST go through these helpers so that:

- Model selection (Gemini Pro vs Gemini Flash vs Claude Opus) is consistent
  and documented.
- `max_tokens` / `timeout` / `max_retries` are set in one place.
- LangSmith tracing picks up every call uniformly via the native
  `langchain-google-genai` / `langchain-anthropic` integrations.

## Model selection rules

- **Gemini 3.1 Pro** (`gemini-3.1-pro-preview`) is used for the main reasoning
  workloads that previously ran on Claude Opus/Sonnet: chat orchestrator,
  integration-research orchestrator, integration-research code writer,
  codebase exploration agent, flow-proposal generator, and the outer QA
  test-executor ReAct loop.

- **Gemini 3 Flash** (`gemini-3-flash-preview`) is the workhorse for the
  lighter-weight, well-scoped summarization tasks: rolling-context compaction
  and the post-run Slack executive summary.

- **Claude Opus 4.6** (`claude-opus-4-6`, via Anthropic) is used ONLY for the
  Stagehand browser agent (session + inner execute agent). Stagehand's CUA
  mode is currently tuned for Claude-family models, so this call path stays
  on Anthropic. We pin to 4.6 rather than 4.7 because Stagehand v3's
  supported CUA-model list
  (https://docs.stagehand.dev/v3/configuration/models) tops out at Opus 4.6
  — the SDK still emits the legacy `computer_20250124` tool schema, which
  Opus 4.7 refuses. The model id is defined in `runner/prompts.py` because
  the Stagehand SDK wants the raw `provider/model-id` string, not a
  LangChain `BaseChatModel` — `get_claude_opus()` below is only used if a
  future non-Stagehand path wants a LangChain-wrapped Opus call.

If a future task needs something even stronger or a new provider, add a
helper here and keep the call sites declarative (`get_gemini_pro()` /
`get_gemini_flash()` / `get_claude_opus()`), not model-name-sprinkled.

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


def get_gemini_pro(
    *,
    max_tokens: int | None = 66_000,
    temperature: float | None = None,
    timeout: float | None = 300.0,
    max_retries: int = 2,
) -> "ChatGoogleGenerativeAI":
    """Gemini 3.1 Pro — the main reasoning model.

    Used for the chat orchestrator, research orchestrator, research code
    writer, codebase explorer, flow-proposal generator, and the outer QA
    test-executor ReAct loop.

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
