"""Compile the chat LangGraph.

The graph itself is small — nodes do the heavy lifting. The key decisions
encoded here:

1. **No checkpointer.** Our persistence model is Supabase (chat_messages +
   chat_sessions); adding LangGraph's checkpointer would create a parallel,
   conflicting source of truth. Every turn builds state fresh in
   `build_initial_state` and commits via DB writes inside nodes.

2. **Tool nodes route directly to `finalize`, not back to `agent_turn`.**
   This preserves the TS behavior `stopWhen: hasToolCall('generate_flow_proposals')`:
   once the tool has executed, we do NOT give the model a second turn that
   would rewrite the cards as prose. The agent's original message
   (including any opening text it emitted alongside the tool_call) is
   what `finalize` persists.

3. **Retry policies on network-bound nodes.** `ensure_research`,
   `tool_generate_flow_proposals`, and `tool_start_test_run` each call
   providers (Anthropic / GitHub / Supabase / Modal) that can transiently
   fail. RetryPolicy with max_attempts=2 handles the common 429/5xx cases
   without being too aggressive.
"""
from __future__ import annotations

from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

from .nodes import (
    agent_turn,
    ensure_research,
    finalize,
    route_after_agent,
    tool_generate_flow_proposals,
    tool_start_test_run,
)
from .state import ChatTurnState


def _build_graph() -> StateGraph:
    graph = StateGraph(ChatTurnState)

    graph.add_node(
        "ensure_research",
        ensure_research,
        retry_policy=RetryPolicy(max_attempts=2, initial_interval=2.0),
    )
    graph.add_node("agent_turn", agent_turn)
    graph.add_node(
        "tool_generate_flow_proposals",
        tool_generate_flow_proposals,
        retry_policy=RetryPolicy(max_attempts=2, initial_interval=2.0),
    )
    graph.add_node(
        "tool_start_test_run",
        tool_start_test_run,
        retry_policy=RetryPolicy(max_attempts=2, initial_interval=2.0),
    )
    graph.add_node("finalize", finalize)

    graph.add_edge(START, "ensure_research")
    graph.add_edge("ensure_research", "agent_turn")
    graph.add_conditional_edges(
        "agent_turn",
        route_after_agent,
        {
            "tool_generate_flow_proposals": "tool_generate_flow_proposals",
            "tool_start_test_run": "tool_start_test_run",
            "finalize": "finalize",
        },
    )
    graph.add_edge("tool_generate_flow_proposals", "finalize")
    graph.add_edge("tool_start_test_run", "finalize")
    graph.add_edge("finalize", END)

    return graph


# Module-level compiled graph. Cheap to construct; re-used across turns
# within a warm Modal container.
agent_app = _build_graph().compile()
