"""Chat turn runner — entry point for Modal's `process_chat_turn`.

Thin orchestrator around the LangGraph agent:

1. Verify the user message row exists (the API route wrote it synchronously
   before spawning us; if it doesn't exist something is wrong upstream and
   we bail rather than hallucinate context).
2. Build initial state from DB (session, project, recent messages,
   research_report, latest flow proposals).
3. Invoke the compiled LangGraph.
4. Unconditionally reset session status + active_chat_call_id in a `finally`
   so a crashing node never leaves the UI stuck on "thinking".

This module is intentionally small. The real work lives in
`runner.chat.graph` (the StateGraph + nodes).
"""
from __future__ import annotations

import secrets
import time
import traceback

from .logging import chat_log
from .supabase_client import get_supabase, set_session_status


async def run_chat_turn(
    session_id: str,
    project_id: str,
    user_message_client_id: str,
) -> None:
    """Execute one chat turn against the durable LangGraph agent.

    Side effects (all via Supabase; no return value):
    - Writes assistant message row(s) to `chat_messages`.
    - May insert `flow_proposals` / `test_run_started` metadata rows.
    - Transitions `chat_sessions.status` through thinking -> idle/error.
    - Clears `active_chat_call_id` on exit.
    """
    sb = get_supabase()
    turn_id = f"turn_{secrets.token_hex(6)}"
    turn_t0 = time.time()

    chat_log(
        "info",
        "chat_turn_started",
        project_id=project_id,
        session_id=session_id,
        turn_id=turn_id,
        user_message_client_id=user_message_client_id,
    )

    try:
        # Lazy import: keeps Modal cold start cheap if only `turn.run_chat_turn`
        # is referenced (e.g. by tests mocking the graph).
        from .graph import agent_app
        from .state import build_initial_state

        state_t0 = time.time()
        initial_state = await build_initial_state(
            sb,
            session_id=session_id,
            project_id=project_id,
            user_message_client_id=user_message_client_id,
            turn_id=turn_id,
        )
        chat_log(
            "info",
            "chat_turn_state_built",
            project_id=project_id,
            session_id=session_id,
            turn_id=turn_id,
            elapsed_s=round(time.time() - state_t0, 3),
            message_count=len(initial_state.get("messages") or []),
            has_research_report=bool(initial_state.get("research_report")),
            has_context_summary=bool(initial_state.get("context_summary")),
            has_latest_flow_proposals=bool(initial_state.get("latest_flow_proposals")),
            recent_run_count=len(initial_state.get("recent_runs") or []),
            github_ready=bool((initial_state.get("github_ready") or {}).get("ok")),
        )

        # `astream` with `stream_mode="updates"` lets us log per-node progress
        # to stdout (which shows up in Modal logs + LangSmith traces). We don't
        # forward anything to the client — all client-visible side effects are
        # DB writes performed inside nodes.
        #
        # `updates` yields one chunk per completed node, so we approximate
        # per-node timing as "wall clock between this update and the previous
        # one". This catches a node that pins on a slow LLM call without
        # needing a checkpointer or a separate `values` stream mode.
        last_update_t = time.time()
        async for chunk in agent_app.astream(initial_state, stream_mode="updates"):
            now = time.time()
            since_last = round(now - last_update_t, 3)
            last_update_t = now
            for node_name, update in chunk.items():
                chat_log(
                    "info",
                    "chat_graph_node_update",
                    project_id=project_id,
                    session_id=session_id,
                    turn_id=turn_id,
                    node=node_name,
                    approx_node_elapsed_s=since_last,
                    update_keys=list(update.keys()) if isinstance(update, dict) else None,
                )

        chat_log(
            "info",
            "chat_turn_ok",
            project_id=project_id,
            session_id=session_id,
            turn_id=turn_id,
            elapsed_s=round(time.time() - turn_t0, 3),
        )

    except Exception as exc:
        chat_log(
            "error",
            "chat_turn_failed",
            project_id=project_id,
            session_id=session_id,
            turn_id=turn_id,
            err=repr(exc),
            traceback=traceback.format_exc(),
        )
        # Best-effort surface the error to the user as an assistant bubble.
        try:
            sb.table("chat_messages").insert(
                {
                    "session_id": session_id,
                    "role": "assistant",
                    "content": (
                        "Sorry — I hit an error while working on that. "
                        "Please try again in a moment."
                    ),
                }
            ).execute()
        except Exception as inner:
            chat_log(
                "error",
                "chat_turn_error_message_insert_failed",
                project_id=project_id,
                session_id=session_id,
                turn_id=turn_id,
                err=repr(inner),
            )
        # Re-raise so Modal's invocation is marked as failed for observability.
        raise
    finally:
        # Belt-and-suspenders: unstick the UI even if finalize didn't run.
        # This mirrors the old Next.js route's `after()` safety net, but
        # runs synchronously in the same process so there's no lifetime
        # ambiguity.
        try:
            set_session_status(sb, session_id, "idle", clear_active_call=True)
        except Exception as cleanup_err:
            chat_log(
                "error",
                "chat_turn_cleanup_failed",
                project_id=project_id,
                session_id=session_id,
                turn_id=turn_id,
                err=repr(cleanup_err),
            )
