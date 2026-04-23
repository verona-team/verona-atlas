"""Central factory for Claude chat models used across the runner.

All LLM calls from the Modal runner MUST go through these helpers so that:

- Model selection (Opus vs Sonnet) is consistent and documented.
- Temperature / max_tokens / timeouts are set in one place.
- LangSmith tracing picks up every call uniformly (via `langchain-anthropic`'s
  native integration; we don't wrap anything manually).

## Model selection rules

- **Opus 4.6** is the orchestrator. Used for the main chat agent that routes
  between `generate_flow_proposals` / `start_test_run` / plain text reply.
  Opus is significantly better at nuanced tool selection, which is the one
  thing this agent MUST get right.

- **Sonnet 4.6** is used for everything else — anything that can be framed
  as "do this well-defined task and return JSON": flow-proposal generation,
  integration research, codebase exploration, context summarization. Sonnet
  is ~5x cheaper and fast enough that these subtasks don't bottleneck a
  turn.

If you find yourself reaching for Haiku, don't — we want consistent quality
at the cost of a few extra tokens. If a future task needs something even
stronger than Opus for edge cases, add a helper here and keep the call sites
declarative (`get_sonnet()` / `get_opus()`), not model-name-sprinkled.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from langchain_anthropic import ChatAnthropic


# Model names — kept as module-level constants so tests can patch a single
# place if they want to hit a cheaper model.
OPUS_MODEL = "claude-opus-4-6"
SONNET_MODEL = "claude-sonnet-4-6"


def get_opus(
    *,
    max_tokens: int = 8192,
    temperature: float = 0.2,
    timeout: float = 180.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Opus 4.6 — the orchestrator.

    Reserved for the main chat-agent loop that has to reliably pick between
    tools. Opus gets a slightly longer timeout because tool-calling turns
    can include a chain of thoughts + tool-use blocks.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=OPUS_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=timeout,
        max_retries=max_retries,
    )


def get_sonnet(
    *,
    max_tokens: int = 8192,
    temperature: float = 0.2,
    timeout: float = 120.0,
    max_retries: int = 2,
) -> "ChatAnthropic":
    """Claude Sonnet 4.6 — the workhorse.

    Used for all structured-output subtasks: flow generation, research,
    codebase exploration, summarization. Temperature is low by default
    because these tasks want determinism, not creativity.
    """
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(
        model=SONNET_MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=timeout,
        max_retries=max_retries,
    )
