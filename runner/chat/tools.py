"""Tool schemas exposed to the chat orchestrator.

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

## Flow proposal lifecycle (one active row per session)

The session holds AT MOST ONE active `flow_proposals` row at any moment.
The orchestrator distinguishes two intents:

- `mode="bootstrap"` — first generation in the session; no prior
  proposals exist. Just inserts a new active row.
- `mode="replace"` — there is an active proposals row; supersede it
  with a newly-generated set. Covers every "regenerate" intent:
  additive ("also propose signup flows"), refining ("swap out flow 2"),
  and clean-slate ("completely new flows").

The two additive/clean-slate flavors are distinguished by which ids the
flow generator chooses to re-emit verbatim, not by a third mode. Re-emitted
ids inherit their prior approval state server-side; all other new flows
start `pending`.
"""
from __future__ import annotations

from typing import Literal

from langchain.tools import tool


@tool
def generate_flow_proposals(
    reason: str,
    mode: Literal["bootstrap", "replace"],
    refresh_research: bool = False,
) -> str:
    """Render up to 3 proposed UI test flows as structured approval cards in the chat UI. The user can only approve flows that come through this tool — prose descriptions cannot be approved. Call this whenever the user wants to see, refresh, add, or propose test flows. Do not describe flows in your written reply; the cards already show the names, priorities, and steps.

    Args:
        reason: One-line summary of WHY you're generating now, phrased to convey the user's preservation intent. This string is fed verbatim to the nested flow-generator LLM so it knows which prior flows (if any) to re-emit. Examples: "initial bootstrap"; "user asked to add signup-funnel coverage while preserving approved flows A and B"; "user wants a completely fresh set; discard prior proposals".
        mode: "bootstrap" for the first generation in a session (no prior active proposals row). "replace" to supersede the current active proposals row with a new one — use this for ALL regeneration intents, both additive and clean-slate.
        refresh_research: Set true only when the user explicitly asks for fresh upstream data (e.g. "re-analyze my repo first"). The server automatically re-runs research on replace regardless, so leaving this false is almost always correct.
    """
    return "called via graph node"


@tool
def start_test_run(confirmation: str) -> str:
    """Kick off a cloud browser run for every currently-approved flow on the active proposals row. Call when the user confirms they want to start testing (phrases like "start testing", "run them", "go"). Requires at least one approved flow on the active row.

    Args:
        confirmation: Short paraphrase of the user's go-ahead, e.g. "user confirmed starting run".
    """
    return "called via graph node"


ALL_TOOLS = [generate_flow_proposals, start_test_run]
