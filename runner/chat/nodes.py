"""LangGraph nodes for the chat orchestrator.

Each node takes a `ChatTurnState` and returns either:

- a `dict` of state updates (merged by LangGraph's reducers), or
- a `Command` object specifying both state updates and the next node.

All Supabase writes live here — the orchestrator LLM never touches the DB
directly. That keeps tool arguments small (the LLM only needs to say
"generate flows" or "start run" with a reason) and gives us one place
to audit the shape of every row we write.

## Flow

    START
      |
      v
    ensure_research            (conditional: skip if research already fresh)
      |
      v
    agent_turn  <---------+    (LLM call with tools bound)
      |                   |
      +-> finalize        |    (no tool_calls -> persist assistant text, end)
      |                   |
      +-> flow_proposals  |    (writes metadata=flow_proposals row, -> finalize)
      |
      +-> start_test_run       (spawns execute_test_run Modal call, -> finalize)
"""
from __future__ import annotations

import asyncio
import json
import time
import traceback
from typing import Any, Literal

from langchain_core.messages import AIMessage, SystemMessage
from langgraph.types import Command
from supabase import Client

from .flow_generator import (
    FlowProposals,
    generate_flow_proposals as run_flow_generator,
    serialize_flows_for_message,
)
from .logging import chat_log
from .models import get_opus
from .prompts import build_orchestrator_system_prompt
from .state import ChatTurnState
from .supabase_client import get_supabase, iso_now, set_session_status
from .tools import ALL_TOOLS
from .context import maybe_summarize_older_messages


# ----- ensure_research -----


async def ensure_research(state: ChatTurnState) -> dict[str, Any]:
    """Run the research agent if we don't have a fresh report on the session.

    The old TS flow re-ran research on every chat turn (with a session-level
    cache check). We preserve that behavior: `research_report` is None the
    first time, and we fill it + persist it. Subsequent turns reuse the
    cached value until a user/tool explicitly refreshes via
    `generate_flow_proposals(refresh=True)`.
    """
    from runner.research.orchestrator import run_research_agent
    from runner.research.types import ResearchReport

    if state.get("research_report"):
        return {}

    sb = get_supabase()
    project_id = state["project_id"]
    app_url = state["app_url"]

    chat_log(
        "info",
        "chat_ensure_research_begin",
        project_id=project_id,
        session_id=state["session_id"],
        turn_id=state.get("turn_id"),
    )

    t0 = time.time()
    report: ResearchReport = await run_research_agent(
        sb, project_id=project_id, app_url=app_url
    )
    report_json = report.model_dump(mode="json")
    chat_log(
        "info",
        "chat_ensure_research_ok",
        project_id=project_id,
        session_id=state["session_id"],
        turn_id=state.get("turn_id"),
        elapsed_s=round(time.time() - t0, 3),
        finding_count=len(report_json.get("findings") or []),
        recommended_flow_count=len(report_json.get("recommendedFlows") or []),
        integrations_covered=report_json.get("integrationsCovered") or [],
        integrations_skipped=report_json.get("integrationsSkipped") or [],
    )

    try:
        sb.table("chat_sessions").update(
            {
                "research_report": report_json,
                "updated_at": iso_now(),
            }
        ).eq("id", state["session_id"]).execute()
    except Exception as e:
        chat_log(
            "warn",
            "chat_ensure_research_persist_failed",
            project_id=project_id,
            session_id=state["session_id"],
            err=repr(e),
        )

    return {"research_report": report_json}


# ----- agent_turn -----


async def agent_turn(state: ChatTurnState) -> dict[str, Any]:
    """Call Opus with the tools bound. Append the AIMessage to state.messages."""
    system = build_orchestrator_system_prompt(
        project_name=state.get("project_name", ""),
        app_url=state.get("app_url", ""),
        research_report=state.get("research_report"),
        latest_flow_proposals=state.get("latest_flow_proposals"),
        context_summary=state.get("context_summary"),
        recent_runs=state.get("recent_runs") or [],
    )

    messages = [SystemMessage(content=system), *state.get("messages", [])]

    model = get_opus().bind_tools(ALL_TOOLS)

    chat_log(
        "info",
        "chat_agent_llm_begin",
        project_id=state.get("project_id"),
        session_id=state.get("session_id"),
        turn_id=state.get("turn_id"),
        message_count=len(messages),
        llm_calls_so_far=state.get("llm_calls") or 0,
    )
    t0 = time.time()

    try:
        response: AIMessage = await model.ainvoke(messages)
    except Exception as e:
        chat_log(
            "error",
            "chat_agent_llm_failed",
            project_id=state.get("project_id"),
            session_id=state.get("session_id"),
            turn_id=state.get("turn_id"),
            elapsed_s=round(time.time() - t0, 3),
            err=repr(e),
        )
        raise

    tool_calls = getattr(response, "tool_calls", None) or []
    chat_log(
        "info",
        "chat_agent_llm_ok",
        project_id=state.get("project_id"),
        session_id=state.get("session_id"),
        turn_id=state.get("turn_id"),
        elapsed_s=round(time.time() - t0, 3),
        tool_call_count=len(tool_calls),
        tool_names=[tc.get("name") for tc in tool_calls],
        has_text_content=bool(
            response.content
            if isinstance(response.content, str)
            else any(
                isinstance(b, dict) and b.get("type") == "text"
                for b in (response.content or [])
            )
        ),
    )

    return {
        "messages": [response],
        "llm_calls": (state.get("llm_calls") or 0) + 1,
    }


# ----- routing -----


def route_after_agent(
    state: ChatTurnState,
) -> Literal["tool_generate_flow_proposals", "tool_start_test_run", "finalize"]:
    """Decide what to do after the orchestrator spoke.

    Behavior mirrors the TS `stopWhen: [stepCountIs(3), hasToolCall(...)]`:
    if the model called a tool, execute it and then finalize (no second
    LLM turn that would re-describe cards). If no tool_calls, finalize
    with whatever text the model emitted.
    """
    messages = state.get("messages") or []
    if not messages:
        return "finalize"
    last = messages[-1]
    tool_calls = getattr(last, "tool_calls", None) or []
    if not tool_calls:
        return "finalize"
    name = tool_calls[0].get("name")
    if name == "generate_flow_proposals":
        return "tool_generate_flow_proposals"
    if name == "start_test_run":
        return "tool_start_test_run"
    # Unknown tool — log and finalize gracefully rather than looping forever.
    chat_log(
        "warn",
        "chat_unknown_tool_call",
        tool_name=name,
        session_id=state.get("session_id"),
    )
    return "finalize"


# ----- tool: generate_flow_proposals -----


async def tool_generate_flow_proposals(state: ChatTurnState) -> dict[str, Any]:
    """Generate flow proposals, insert the chat_messages row, return to finalize.

    The LLM's AIMessage included a `generate_flow_proposals` tool_call; we
    read its args (refresh flag), re-run research if needed, call the
    flow generator, and write the row. The final AIMessage.content text
    that Claude emitted alongside the tool_call is preserved as the
    assistant bubble text in `finalize`.
    """
    sb = get_supabase()
    messages = state.get("messages") or []
    last = messages[-1]
    tool_calls = getattr(last, "tool_calls", None) or []
    tc = tool_calls[0] if tool_calls else {}
    args = tc.get("args") or {}
    refresh = bool(args.get("refresh"))

    project_id = state["project_id"]
    session_id = state["session_id"]
    app_url = state.get("app_url", "")

    chat_log(
        "info",
        "chat_tool_flow_proposals_begin",
        project_id=project_id,
        session_id=session_id,
        refresh=refresh,
    )

    # Refresh path: re-run research, persist, update state so downstream
    # uses the new report.
    research_report = state.get("research_report")
    if refresh:
        from runner.research.orchestrator import run_research_agent

        try:
            report = await run_research_agent(
                sb, project_id=project_id, app_url=app_url
            )
            research_report = report.model_dump(mode="json")
            sb.table("chat_sessions").update(
                {"research_report": research_report, "updated_at": iso_now()}
            ).eq("id", session_id).execute()
        except Exception as e:
            chat_log(
                "error",
                "chat_tool_flow_proposals_refresh_failed",
                project_id=project_id,
                err=repr(e),
            )

    if not research_report:
        return {
            "inserted_flow_proposal_message_id": None,
        }

    try:
        proposals: FlowProposals = await run_flow_generator(
            app_url=app_url, research_report=research_report
        )
    except Exception as e:
        chat_log(
            "error",
            "chat_tool_flow_proposals_llm_failed",
            project_id=project_id,
            err=repr(e),
            traceback=traceback.format_exc(),
        )
        raise

    content, metadata, flows = serialize_flows_for_message(proposals)

    try:
        resp = (
            sb.table("chat_messages")
            .insert(
                {
                    "session_id": session_id,
                    "role": "assistant",
                    "content": content,
                    "metadata": metadata,
                }
            )
            .execute()
        )
        inserted_id: str | None = None
        inserted_rows = resp.data or []
        if inserted_rows:
            inserted_id = inserted_rows[0].get("id")
    except Exception as e:
        chat_log(
            "error",
            "chat_tool_flow_proposals_db_insert_failed",
            project_id=project_id,
            err=repr(e),
        )
        inserted_id = None

    chat_log(
        "info",
        "chat_tool_flow_proposals_ok",
        project_id=project_id,
        session_id=session_id,
        flow_count=len(flows),
        flow_names=[f.name for f in flows],
    )

    return {
        "inserted_flow_proposal_message_id": inserted_id,
        "research_report": research_report,
    }


# ----- tool: start_test_run -----


async def tool_start_test_run(state: ChatTurnState) -> dict[str, Any]:
    """Materialize approved flows into templates + a test_runs row + spawn Modal.

    Same behavior as the TS `executeStartTestRun` — the only meaningful
    change is that we're spawning `execute_test_run` from inside another
    Modal function, which works fine because the Python Modal client reads
    `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` from env.
    """
    sb = get_supabase()
    session_id = state["session_id"]
    project_id = state["project_id"]

    chat_log(
        "info",
        "chat_tool_start_test_run_begin",
        session_id=session_id,
        project_id=project_id,
    )

    # Re-read the latest proposals from the DB rather than trusting state,
    # so flows the user approved/rejected since the turn started are visible.
    latest_meta: dict[str, Any] | None = None
    try:
        proposals_resp = (
            sb.table("chat_messages")
            .select("metadata")
            .eq("session_id", session_id)
            .eq("metadata->>type", "flow_proposals")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = proposals_resp.data or []
        if rows:
            latest_meta = rows[0].get("metadata") or {}
    except Exception as e:
        chat_log(
            "warn",
            "chat_tool_start_test_run_meta_fetch_failed",
            session_id=session_id,
            err=repr(e),
        )

    if not latest_meta:
        return _start_test_run_failure(
            session_id,
            "Could not find flow proposals for this session. Ask the user to "
            "generate proposals again, then approve flows before starting.",
        )

    flow_states = latest_meta.get("flow_states") or {}
    approved_ids = [fid for fid, s in flow_states.items() if s == "approved"]
    if not approved_ids:
        return _start_test_run_failure(
            session_id,
            "No approved flows. The user needs to approve at least one flow before starting.",
        )

    proposals = latest_meta.get("proposals") or {}
    flows = proposals.get("flows") if isinstance(proposals, dict) else None
    if not isinstance(flows, list) or not flows:
        return _start_test_run_failure(
            session_id,
            "Could not find flow proposals for this session. Ask the user to "
            "generate proposals again, then approve flows before starting.",
        )

    approved_flows = [f for f in flows if isinstance(f, dict) and f.get("id") in approved_ids]
    if not approved_flows:
        return _start_test_run_failure(
            session_id,
            "No approved flows match the current proposal set. Regenerate flow "
            "proposals or approve flows again, then start testing.",
        )

    created_template_ids: list[str] = []
    template_insert_errors: list[str] = []
    for flow in approved_flows:
        try:
            t_resp = (
                sb.table("test_templates")
                .insert(
                    {
                        "project_id": project_id,
                        "name": flow.get("name") or "Unnamed flow",
                        "description": flow.get("description") or "",
                        "steps": flow.get("steps") or [],
                        "source": "chat_generated",
                    }
                )
                .execute()
            )
            rows = t_resp.data or []
            if rows and rows[0].get("id"):
                created_template_ids.append(rows[0]["id"])
            else:
                template_insert_errors.append("empty response")
        except Exception as e:
            template_insert_errors.append(f"{type(e).__name__}: {e}")

    if len(created_template_ids) != len(approved_flows):
        chat_log(
            "error",
            "chat_tool_start_test_run_partial_template_save",
            session_id=session_id,
            approved=len(approved_flows),
            saved=len(created_template_ids),
            errors=template_insert_errors,
        )
        msg = (
            "Could not save approved flows to the database, so cloud browsers "
            "were not started."
        )
        if template_insert_errors:
            msg += " " + " ".join(template_insert_errors)
        return _start_test_run_failure(session_id, msg)

    # Create the test_runs row first (Modal needs its id as an arg).
    try:
        run_resp = (
            sb.table("test_runs")
            .insert(
                {
                    "project_id": project_id,
                    "trigger": "chat",
                    "status": "pending",
                    "trigger_ref": json.dumps({"template_ids": created_template_ids}),
                }
            )
            .execute()
        )
        run_rows = run_resp.data or []
        if not run_rows:
            return _start_test_run_failure(
                session_id, "Failed to create test run — no row returned."
            )
        test_run_id: str = run_rows[0]["id"]
    except Exception as e:
        return _start_test_run_failure(
            session_id, f"Failed to create test run: {type(e).__name__}: {e}"
        )

    # Spawn execute_test_run from inside this Modal function. The env has
    # MODAL_TOKEN_ID/MODAL_TOKEN_SECRET so the nested client auto-authenticates.
    modal_call_id: str | None = None
    try:
        import modal

        fn = modal.Function.from_name("atlas-runner", "execute_test_run")
        call = fn.spawn(test_run_id, project_id)
        modal_call_id = call.object_id  # modal-python attribute name
    except Exception as e:
        chat_log(
            "error",
            "chat_tool_start_test_run_modal_spawn_failed",
            session_id=session_id,
            run_id=test_run_id,
            err=repr(e),
        )
        try:
            sb.table("test_runs").update(
                {
                    "status": "failed",
                    "summary": {
                        "error": "Failed to trigger Modal",
                        "details": f"{type(e).__name__}: {e}",
                    },
                }
            ).eq("id", test_run_id).execute()
        except Exception:
            pass
        return _start_test_run_failure(
            session_id, f"Failed to trigger test execution: {type(e).__name__}: {e}"
        )

    # Best-effort: persist modal_call_id onto the test_runs row.
    try:
        if modal_call_id:
            sb.table("test_runs").update({"modal_call_id": modal_call_id}).eq(
                "id", test_run_id
            ).execute()
    except Exception as e:
        chat_log(
            "warn",
            "chat_tool_start_test_run_persist_modal_id_failed",
            err=repr(e),
        )

    # User-visible "Testing started" chat bubble. Same metadata shape the UI
    # already renders — do not change without a matching client change.
    try:
        sb.table("chat_messages").insert(
            {
                "session_id": session_id,
                "role": "assistant",
                "content": (
                    f"Testing started! I'm executing {len(approved_flows)} approved "
                    "flow(s) in cloud browsers. I'll update you on progress as results come in."
                ),
                "metadata": {
                    "type": "test_run_started",
                    "run_id": test_run_id,
                    "template_ids": created_template_ids,
                    "flow_count": len(approved_flows),
                },
            }
        ).execute()
    except Exception as e:
        chat_log(
            "warn",
            "chat_tool_start_test_run_bubble_insert_failed",
            session_id=session_id,
            err=repr(e),
        )

    chat_log(
        "info",
        "chat_tool_start_test_run_ok",
        session_id=session_id,
        run_id=test_run_id,
        modal_call_id=modal_call_id,
        flow_count=len(approved_flows),
    )

    return {
        "spawned_test_run_id": test_run_id,
        "spawned_modal_call_id": modal_call_id,
    }


def _start_test_run_failure(session_id: str, message: str) -> dict[str, Any]:
    """Write a visible assistant error bubble and return empty state updates."""
    sb = get_supabase()
    try:
        sb.table("chat_messages").insert(
            {
                "session_id": session_id,
                "role": "assistant",
                "content": message,
            }
        ).execute()
    except Exception as e:
        chat_log(
            "warn",
            "chat_tool_start_test_run_failure_bubble_insert_failed",
            session_id=session_id,
            err=repr(e),
        )
    return {}


# ----- finalize -----


async def finalize(state: ChatTurnState) -> dict[str, Any]:
    """Persist the assistant reply and reset session status.

    Extracts the final text from the most recent AIMessage — Claude's
    `AIMessage.content` can be either a plain string (text-only turn) or
    a list of content blocks (text + tool_use interleaved). We concatenate
    only the text blocks.

    Idempotency: we upsert on `(session_id, client_message_id)` so a
    Modal retry or a duplicate spawn never duplicates the assistant row.
    """
    sb = get_supabase()
    session_id = state["session_id"]
    messages = state.get("messages") or []

    # Find the most recent AIMessage; that's our reply.
    assistant_text = ""
    for m in reversed(messages):
        if isinstance(m, AIMessage):
            if isinstance(m.content, str):
                assistant_text = m.content.strip()
            elif isinstance(m.content, list):
                parts: list[str] = []
                for block in m.content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        t = block.get("text")
                        if isinstance(t, str):
                            parts.append(t)
                    elif isinstance(block, str):
                        parts.append(block)
                assistant_text = "".join(parts).strip()
            break

    assistant_message_id = state.get("assistant_message_id")

    # Persist the assistant bubble ONLY if we have actual text.
    # (A pure-tool turn — e.g. generate_flow_proposals emits a tool_call and
    # no trailing text — leaves assistant_text empty; the tool already
    # inserted its own visible row, so we don't add a redundant bubble.)
    if assistant_text:
        try:
            sb.table("chat_messages").upsert(
                {
                    "session_id": session_id,
                    "role": "assistant",
                    "content": assistant_text,
                    "client_message_id": assistant_message_id,
                },
                on_conflict="session_id,client_message_id",
                ignore_duplicates=True,
            ).execute()
        except Exception as e:
            chat_log(
                "error",
                "chat_finalize_assistant_persist_failed",
                session_id=session_id,
                err=repr(e),
            )

    # Rolling-summary compaction (best-effort).
    try:
        await maybe_summarize_older_messages(sb, session_id)
    except Exception as e:
        chat_log(
            "warn",
            "chat_finalize_summarize_failed",
            session_id=session_id,
            err=repr(e),
        )

    # Mark session idle + clear the active Modal call. `turn.run_chat_turn`
    # also does this in its `finally` block as a safety net; doing it here
    # means the UI unblocks at the precise moment the turn is actually done
    # rather than a few hundred ms later when the Modal function exits.
    try:
        set_session_status(sb, session_id, "idle", clear_active_call=True)
    except Exception as e:
        chat_log(
            "warn",
            "chat_finalize_session_status_failed",
            session_id=session_id,
            err=repr(e),
        )

    return {"finalized": True}
