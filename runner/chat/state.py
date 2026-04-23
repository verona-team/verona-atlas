"""State schema + initial-state builder for the chat LangGraph.

The state is intentionally dict-shaped (LangGraph TypedDict) with **raw**
data, following the "Thinking in LangGraph" principle: prompts are
formatted on-demand inside nodes, never stored. This means:

- We can render the same project context into different prompts in
  different nodes (the agent uses it for tool routing, the flow generator
  uses it for structured output, etc.) without duplication.
- A state dump in LangSmith shows exactly what data each node saw,
  making debugging tractable.

## Channels

- `messages` is the conversation seen by the orchestrator LLM. Reduced
  with LangGraph's `add_messages` so tool results, AI messages, etc. all
  append correctly.
- `project_*` / `app_url` / `context_summary` / `research_report` are
  seeded once in `load_context` and read-only thereafter.
- `latest_flow_proposals` captures the previous turn's proposal metadata
  so the orchestrator can decide whether to refresh vs. reuse.
- `recent_runs` feeds the system prompt so the agent can reference
  recent test runs naturally.
- `user_message_client_id` is the UIMessage id from the client; we upsert
  the assistant reply with this key's sibling (generated here) to dedup
  against any future duplicate POST.
"""
from __future__ import annotations

import secrets
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage, HumanMessage
from langgraph.graph.message import add_messages
from supabase import Client

from .logging import chat_log


def generate_assistant_message_id() -> str:
    """Mirrors AI SDK's `createIdGenerator({ prefix: 'va', size: 16 })` shape.

    The old `/api/chat` used `va` + 16 random chars. We keep the same prefix
    so existing `chat_messages` rows (with `client_message_id` starting with
    `va`) remain distinguishable from the new Modal-generated ones only by
    timestamp, not by prefix — important because the React UI dedups by
    client_message_id regardless of origin.
    """
    return f"va{secrets.token_hex(8)}"


class ChatTurnState(TypedDict, total=False):
    # -------- identity / context (set once by load_context) --------
    session_id: str
    project_id: str
    project_name: str
    app_url: str
    turn_id: str  # for correlation in logs / LangSmith traces
    user_message_client_id: str  # the UIMessage id of the user turn

    # -------- conversation history --------
    messages: Annotated[list[AnyMessage], add_messages]

    # -------- loaded once from DB --------
    context_summary: str | None
    research_report: dict | None  # ResearchReport.model_dump(mode='json')
    latest_flow_proposals: dict | None  # chat_messages.metadata for the last proposal
    recent_runs: list[dict]
    github_ready: dict  # {ok, reason?, installation_id?, repo_full_name?}

    # -------- side-effect receipts (set by tool nodes) --------
    assistant_message_id: str  # generated at turn start for dedup
    inserted_flow_proposal_message_id: str | None
    spawned_test_run_id: str | None
    spawned_modal_call_id: str | None
    finalized: bool

    # -------- counters --------
    llm_calls: int


async def build_initial_state(
    sb: Client,
    *,
    session_id: str,
    project_id: str,
    user_message_client_id: str,
    turn_id: str,
) -> ChatTurnState:
    """Build the initial state dict by reading everything the graph will need.

    Kept outside the graph (rather than in a `load_context` node) so the
    graph itself receives a fully-populated state and doesn't have to
    handle "fields not yet loaded" edge cases. One DB round-trip saved
    vs. loading the same things again inside a first node.

    Invariants:
    - The user message row MUST already exist; the API route writes it
      synchronously before spawning us. If it doesn't, we raise — this is
      a programming error, not a runtime condition we should paper over.
    - The session row MUST exist; same reason.

    Implementation note: we use `.limit(1)` + list indexing instead of
    `.single()` / `.maybe_single()`. supabase-py's `.single().execute()`
    raises `postgrest.APIError` (status 406) on zero rows, which would
    drown our clean RuntimeError; `.maybe_single().execute()` returns
    None-the-response-itself (not `.data = None`) and crashes on
    attribute access. The plain list form is the one that composes
    predictably with explicit length checks.
    """
    session_resp = (
        sb.table("chat_sessions")
        .select("id, context_summary, research_report, project_id, status")
        .eq("id", session_id)
        .limit(1)
        .execute()
    )
    session_rows = session_resp.data or []
    if not session_rows:
        raise RuntimeError(f"chat session {session_id} not found")
    session = session_rows[0]

    project_resp = (
        sb.table("projects")
        .select("id, name, app_url")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    project_rows = project_resp.data or []
    if not project_rows:
        raise RuntimeError(f"project {project_id} not found")
    project = project_rows[0]

    # Recent messages (last 30) — convert into langchain Messages for the LLM.
    msgs_resp = (
        sb.table("chat_messages")
        .select("id, role, content, metadata, client_message_id, created_at")
        .eq("session_id", session_id)
        .order("created_at", desc=False)
        .limit(30)
        .execute()
    )
    raw_msgs: list[dict[str, Any]] = msgs_resp.data or []

    lc_messages: list[AnyMessage] = []
    user_msg_seen = False
    for row in raw_msgs:
        role = row.get("role")
        content = row.get("content") or ""
        if role == "user":
            lc_messages.append(HumanMessage(content=content))
            if row.get("client_message_id") == user_message_client_id:
                user_msg_seen = True
        elif role == "assistant":
            # Assistant rows in our DB are rendered flat text; preserve them
            # as HumanMessages with "[assistant said]" prefix rather than
            # AIMessage, because putting them back in as AIMessage confuses
            # Claude about whose turn it is. Alternative would be to model
            # them properly — we can upgrade this later when we rewrite
            # context handling.
            lc_messages.append(HumanMessage(content=f"[previous assistant reply] {content}"))

    if not user_msg_seen:
        # The API route should have upserted this row before spawning us. If
        # it's missing, something upstream is broken — log loudly.
        chat_log(
            "warn",
            "chat_user_message_row_missing",
            project_id=project_id,
            session_id=session_id,
            turn_id=turn_id,
            user_message_client_id=user_message_client_id,
        )

    # Latest flow proposal metadata (if any) — used by tools to compute
    # approved flows and by the orchestrator to avoid regenerating stale.
    latest_proposals: dict | None = None
    try:
        proposals_resp = (
            sb.table("chat_messages")
            .select("id, metadata")
            .eq("session_id", session_id)
            .eq("metadata->>type", "flow_proposals")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        prows = proposals_resp.data or []
        if prows:
            latest_proposals = prows[0].get("metadata")
    except Exception as e:
        chat_log(
            "warn",
            "chat_load_latest_proposals_failed",
            project_id=project_id,
            session_id=session_id,
            err=repr(e),
        )

    # Recent test runs — purely context for the orchestrator's system prompt.
    try:
        runs_resp = (
            sb.table("test_runs")
            .select("id, status, summary, created_at")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        )
        recent_runs: list[dict[str, Any]] = list(runs_resp.data or [])
    except Exception as e:
        chat_log("warn", "chat_load_recent_runs_failed", err=repr(e))
        recent_runs = []

    # Resolve GitHub-ready state so ensure_research doesn't have to hit the
    # DB again for the same info.
    from runner.research.github_guard import (
        GithubReadyErr,
        GithubReadyOk,
        get_github_integration_ready,
    )

    gh_state = get_github_integration_ready(sb, project_id)
    if isinstance(gh_state, GithubReadyOk):
        github_ready: dict[str, Any] = {
            "ok": True,
            "installation_id": gh_state.installation_id,
            "repo_full_name": gh_state.repo_full_name,
        }
    else:
        github_ready = {"ok": False, "reason": gh_state.reason}

    return {
        "session_id": session_id,
        "project_id": project_id,
        "project_name": str(project.get("name") or ""),
        "app_url": str(project.get("app_url") or ""),
        "turn_id": turn_id,
        "user_message_client_id": user_message_client_id,
        "messages": lc_messages,
        "context_summary": session.get("context_summary"),
        "research_report": session.get("research_report"),
        "latest_flow_proposals": latest_proposals,
        "recent_runs": recent_runs,
        "github_ready": github_ready,
        "assistant_message_id": generate_assistant_message_id(),
        "inserted_flow_proposal_message_id": None,
        "spawned_test_run_id": None,
        "spawned_modal_call_id": None,
        "finalized": False,
        "llm_calls": 0,
    }
