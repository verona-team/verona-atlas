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

- **Claude Opus 4.7** (`claude-opus-4-7`, via Anthropic) is used ONLY for the
  Stagehand browser agent (session + inner execute agent). Stagehand's CUA
  mode is currently tuned for Claude-family models, so this call path stays
  on Anthropic. The model id is defined in `runner/prompts.py` because the
  Stagehand SDK wants the raw `provider/model-id` string, not a LangChain
  `BaseChatModel` — `get_claude_opus()` below is only used if a future
  non-Stagehand path wants a LangChain-wrapped Opus call.

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
CLAUDE_OPUS_MODEL = "claude-opus-4-7"


def get_gemini_pro(
    *,
    max_tokens: int | None = 8192,
    temperature: float | None = None,
    timeout: float | None = 180.0,
    max_retries: int = 2,
) -> "ChatGoogleGenerativeAI":
    """Gemini 3.1 Pro — the main reasoning model.

    Used for the chat orchestrator, research orchestrator, research code
    writer, codebase explorer, flow-proposal generator, and the outer QA
    test-executor ReAct loop.

    Timeout is generous because tool-calling turns can include a chain of
    thinking + tool-use blocks on Gemini 3 Pro (reasoning model).
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
    max_tokens: int | None = 4096,
    temperature: float | None = None,
    timeout: float | None = 120.0,
    max_retries: int = 2,
) -> "ChatGoogleGenerativeAI":
    """Gemini 3 Flash — the cheap/fast summarization model.

    Used for rolling conversation-context compaction and the post-test-run
    Slack executive summary. These are short, well-scoped tasks where we
    want throughput and cost, not peak reasoning.
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
    max_tokens: int = 8192,
    temperature: float = 0.2,
    timeout: float = 180.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.7 — reserved for the Stagehand browser agent path.

    The Stagehand SDK consumes this model via its own agent/session config
    (see `runner/prompts.py` + `runner/browser.py`) which speaks directly
    to the Anthropic API. This helper exists so any future non-Stagehand
    LangChain path that needs Opus can get a configured `ChatAnthropic`
    without re-pinning the model id.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=CLAUDE_OPUS_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=timeout,
        max_retries=max_retries,
    )
