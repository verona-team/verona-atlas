"""Tool schemas exposed to the Opus orchestrator.

These are **schema only** — the function bodies here are never executed
against a real tool invocation; we route each tool call to its matching
LangGraph node instead (which has full access to state + Supabase).

Why not execute in the tool body? Because:
- The tool body is synchronous from LangGraph's perspective unless we
  wrap it in a lot of machinery, and our real tool work is async
  (Supabase, Modal spawn, nested LLM calls).
- State mutation from the tool body would require threading `state`
  through every call, which LangChain's `@tool` decorator doesn't do
  naturally. A dedicated node with full state access is cleaner.
- We get per-tool retry policies on the node without affecting the LLM
  loop.

So: the orchestrator emits `tool_calls`; our `route_after_agent` routing
function inspects the call and routes to the matching node, which reads
the call args from `state.messages[-1].tool_calls[0].args` and does the
real work.
"""
from __future__ import annotations

from langchain.tools import tool


@tool
def generate_flow_proposals(reason: str, refresh: bool = False) -> str:
    """Render up to 3 proposed UI test flows as structured approval cards in the chat UI. The user can only approve flows that come through this tool — prose descriptions cannot be approved. Call this any time the user asks to see, refresh, add, or propose test flows, or when bootstrapping a new session. Do not describe flows in your written reply; the cards already show the names, priorities, and steps.

    Args:
        reason: Why you are generating proposals now, e.g. "initial bootstrap" or "user asked for auth-focused flows".
        refresh: Set true only when the user explicitly asks for fresh data — re-runs the research agent before generating.
    """
    # Body is unused — the LangGraph node handles the real work.
    return "called via graph node"


@tool
def start_test_run(confirmation: str) -> str:
    """Kick off a cloud browser run for every currently-approved flow. Call when the user confirms they want to start testing (phrases like "start testing", "run them", "go"). Requires at least one approved flow.

    Args:
        confirmation: Short paraphrase of the user's go-ahead, e.g. "user confirmed starting run".
    """
    return "called via graph node"


ALL_TOOLS = [generate_flow_proposals, start_test_run]
