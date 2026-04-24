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

## Flow-proposal lifecycle — one active row per session

At most one `flow_proposals` chat_messages row per session has
`metadata.status == 'active'` at any moment. On each `replace`-mode call
we atomically insert a new active row and flip the prior one to
`superseded`, stamping `superseded_by_message_id` on it. `start_test_run`
only ever executes flows on the active row.

Carry-over of approvals across replacements is opt-in per id: if the
flow generator re-emits a prior id verbatim, the prior approval state is
copied onto the new row; otherwise the new flow starts `pending`. See
`runner.chat.flow_generator.serialize_flows_for_message`.
"""
from __future__ import annotations

import json
import time
import traceback
from typing import Any, Literal

from langchain_core.messages import AIMessage, SystemMessage
from supabase import Client

from .flow_generator import (
    FlowProposals,
    PriorFlowSummary,
    generate_flow_proposals as run_flow_generator,
    serialize_flows_for_message,
)
from .logging import chat_log
from .models import get_gemini_pro
from .prompts import build_orchestrator_system_prompt
from .state import ChatTurnState
from .supabase_client import get_supabase, iso_now, set_session_status
from .tools import ALL_TOOLS
from .context import maybe_summarize_older_messages


# ----- ensure_research -----


async def ensure_research(state: ChatTurnState) -> dict[str, Any]:
    """Run the research agent if we don't have a fresh report on the session.

    `research_report` is None the first time, and we fill it + persist it.
    Subsequent turns reuse the cached value until a user/tool explicitly
    refreshes via `generate_flow_proposals(refresh_research=True)` or
    (implicitly) via a replace-mode call, which always refreshes research
    from inside `tool_generate_flow_proposals`.
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
        findings_with_raw_data=sum(
            1
            for f in (report_json.get("findings") or [])
            if isinstance(f, dict) and (f.get("rawData") or "").strip()
        ),
        drill_in_highlight_count=len(report_json.get("drillInHighlights") or []),
        recommended_flow_count=len(report_json.get("recommendedFlows") or []),
        integrations_covered=report_json.get("integrationsCovered") or [],
        integrations_skipped=report_json.get("integrationsSkipped") or [],
        code_evidence_count=len(
            (report_json.get("codebaseExploration") or {}).get("keyEvidence") or []
        ),
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
    """Call Gemini 3.1 Pro with the tools bound. Append the AIMessage to state.messages."""
    system = build_orchestrator_system_prompt(
        project_name=state.get("project_name", ""),
        app_url=state.get("app_url", ""),
        research_report=state.get("research_report"),
        latest_flow_proposals=state.get("latest_flow_proposals"),
        context_summary=state.get("context_summary"),
        recent_runs=state.get("recent_runs") or [],
        active_flow_proposal_message_id=state.get("active_flow_proposal_message_id"),
    )

    messages = [SystemMessage(content=system), *state.get("messages", [])]

    model = get_gemini_pro().bind_tools(ALL_TOOLS)

    chat_log(
        "info",
        "chat_agent_llm_begin",
        project_id=state.get("project_id"),
        session_id=state.get("session_id"),
        turn_id=state.get("turn_id"),
        message_count=len(messages),
        llm_calls_so_far=state.get("llm_calls") or 0,
        has_active_proposals=bool(state.get("active_flow_proposal_message_id")),
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
        tool_args=[tc.get("args") for tc in tool_calls],
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

    If the model called a tool, execute it and then finalize (no second
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
    chat_log(
        "warn",
        "chat_unknown_tool_call",
        tool_name=name,
        session_id=state.get("session_id"),
    )
    return "finalize"


# ----- tool: generate_flow_proposals -----


def _fetch_active_flow_proposals_row(
    sb: Client, session_id: str
) -> dict[str, Any] | None:
    """Return the single active flow_proposals row for this session, or None.

    Invariant: there is at most one `status='active'` row per session. If
    we ever observe more than one (bug), we log loudly and return the
    newest; downstream treats it as the one to supersede.
    """
    resp = (
        sb.table("chat_messages")
        .select("id, metadata, created_at")
        .eq("session_id", session_id)
        .eq("metadata->>type", "flow_proposals")
        .eq("metadata->>status", "active")
        .order("created_at", desc=True)
        .execute()
    )
    rows = resp.data or []
    if len(rows) > 1:
        chat_log(
            "error",
            "chat_multiple_active_flow_proposals",
            session_id=session_id,
            count=len(rows),
            row_ids=[r.get("id") for r in rows],
        )
    return rows[0] if rows else None


def _prior_summaries_from_row(
    row: dict[str, Any],
) -> tuple[list[PriorFlowSummary], dict[str, str], list[str]]:
    """Pull prior-flow summaries + flow_states + avoid_ids out of an active row.

    Tolerates legacy rows where fields are missing by returning empty
    collections — the generator will treat the regeneration as a
    bootstrap-like fresh generation in that case.
    """
    metadata = row.get("metadata") or {}
    proposals = metadata.get("proposals") or {}
    raw_flows = proposals.get("flows") if isinstance(proposals, dict) else None
    flow_states_raw = metadata.get("flow_states") or {}

    prior_summaries: list[PriorFlowSummary] = []
    avoid_ids: list[str] = []
    flow_states: dict[str, str] = {}

    if isinstance(raw_flows, list):
        for f in raw_flows:
            if not isinstance(f, dict):
                continue
            fid = f.get("id")
            if not isinstance(fid, str) or not fid:
                continue
            state_val = flow_states_raw.get(fid, "pending")
            if state_val not in ("pending", "approved", "rejected"):
                state_val = "pending"
            prior_summaries.append(
                PriorFlowSummary(
                    id=fid,
                    name=str(f.get("name") or fid),
                    rationale=str(f.get("rationale") or ""),
                    state=state_val,
                )
            )
            avoid_ids.append(fid)
            flow_states[fid] = state_val

    return prior_summaries, flow_states, avoid_ids


async def tool_generate_flow_proposals(state: ChatTurnState) -> dict[str, Any]:
    """Generate flow proposals, insert a new active row, and supersede the prior one.

    The LLM's AIMessage included a `generate_flow_proposals` tool_call; we
    read its args (`mode`, `reason`, `refresh_research`), optionally re-run
    research, call the flow generator with prior-row context, insert the
    new row, and flip the prior row's metadata to `status='superseded'`.

    The final AIMessage.content text Opus emitted alongside the tool_call is
    preserved as the assistant bubble text in `finalize`.
    """
    sb = get_supabase()
    messages = state.get("messages") or []
    last = messages[-1]
    tool_calls = getattr(last, "tool_calls", None) or []
    tc = tool_calls[0] if tool_calls else {}
    args = tc.get("args") or {}
    mode = args.get("mode") or "bootstrap"
    reason = str(args.get("reason") or "").strip()
    refresh_research_explicit = bool(args.get("refresh_research"))

    if mode not in ("bootstrap", "replace"):
        chat_log(
            "warn",
            "chat_tool_flow_proposals_invalid_mode",
            session_id=state.get("session_id"),
            mode=mode,
        )
        # Coerce unknown modes to bootstrap if there is no active row,
        # otherwise replace — safe default: never leave a stale active row.
        mode = "bootstrap" if not state.get("active_flow_proposal_message_id") else "replace"

    project_id = state["project_id"]
    session_id = state["session_id"]
    app_url = state.get("app_url", "")

    # -------- Load the prior active row (for replace only) --------
    prior_row: dict[str, Any] | None = None
    prior_flow_summaries: list[PriorFlowSummary] = []
    prior_flow_states: dict[str, str] = {}
    avoid_ids: list[str] = []
    if mode == "replace":
        prior_row = _fetch_active_flow_proposals_row(sb, session_id)
        if prior_row is None:
            # The orchestrator thought we were in replace-mode but no active
            # row exists — a state desync. Gracefully downgrade to bootstrap
            # rather than refusing the user: a redundant empty avoid-list
            # bootstrap is strictly better than a no-op.
            chat_log(
                "warn",
                "chat_tool_flow_proposals_replace_without_active",
                session_id=session_id,
            )
            mode = "bootstrap"
        else:
            (
                prior_flow_summaries,
                prior_flow_states,
                avoid_ids,
            ) = _prior_summaries_from_row(prior_row)

    chat_log(
        "info",
        "chat_tool_flow_proposals_begin",
        project_id=project_id,
        session_id=session_id,
        mode=mode,
        reason=reason,
        refresh_research=refresh_research_explicit,
        prior_flow_count=len(prior_flow_summaries),
        prior_approved_ids=[
            pf.id for pf in prior_flow_summaries if pf.state == "approved"
        ],
    )

    # -------- Refresh research if appropriate --------
    # Replace-mode always refreshes (the user asked for different flows; reusing
    # a stale report is the single biggest cause of near-duplicate output).
    # Bootstrap only refreshes if the orchestrator explicitly requested it.
    research_report = state.get("research_report")
    should_refresh = refresh_research_explicit or mode == "replace"
    if should_refresh:
        from runner.research.orchestrator import run_research_agent

        try:
            report = await run_research_agent(
                sb, project_id=project_id, app_url=app_url
            )
            research_report = report.model_dump(mode="json")
            sb.table("chat_sessions").update(
                {"research_report": research_report, "updated_at": iso_now()}
            ).eq("id", session_id).execute()
            chat_log(
                "info",
                "chat_tool_flow_proposals_research_refreshed",
                project_id=project_id,
                session_id=session_id,
                mode=mode,
            )
        except Exception as e:
            chat_log(
                "error",
                "chat_tool_flow_proposals_refresh_failed",
                project_id=project_id,
                err=repr(e),
            )
            # Fall through to try generation with the cached report; better
            # to ship slightly stale flows than to bail on the turn.

    if not research_report:
        chat_log(
            "error",
            "chat_tool_flow_proposals_no_research_report",
            session_id=session_id,
        )
        return {"inserted_flow_proposal_message_id": None}

    # -------- Generate new flow proposals --------
    try:
        proposals: FlowProposals = await run_flow_generator(
            app_url=app_url,
            research_report=research_report,
            prior_flows=prior_flow_summaries or None,
            avoid_ids=avoid_ids or None,
            intent=reason or None,
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

    content, metadata, flows = serialize_flows_for_message(
        proposals,
        prior_flow_states=prior_flow_states or None,
        prior_flows=prior_flow_summaries or None,
        avoid_ids=avoid_ids or None,
    )

    # -------- Insert the new active row --------
    inserted_id: str | None = None
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

    # -------- Supersede the prior row (replace only) --------
    # Order matters: insert first so there is always at least one row to
    # render even if the supersede update fails. If we flipped the old row
    # first and the insert then failed, the user would see ZERO active card
    # stacks until the next turn.
    if mode == "replace" and prior_row is not None and inserted_id is not None:
        try:
            prior_metadata = dict(prior_row.get("metadata") or {})
            prior_metadata["status"] = "superseded"
            prior_metadata["superseded_by_message_id"] = inserted_id
            sb.table("chat_messages").update({"metadata": prior_metadata}).eq(
                "id", prior_row["id"]
            ).execute()
            chat_log(
                "info",
                "chat_tool_flow_proposals_superseded_prior",
                session_id=session_id,
                prior_message_id=prior_row["id"],
                new_message_id=inserted_id,
            )
        except Exception as e:
            # Two active rows is a soft bug: the client picks the newest
            # and renders both card stacks as active until the next turn.
            # `_fetch_active_flow_proposals_row` logs an error when it
            # sees the anomaly, which surfaces it in observability.
            chat_log(
                "error",
                "chat_tool_flow_proposals_supersede_failed",
                session_id=session_id,
                prior_message_id=prior_row["id"],
                new_message_id=inserted_id,
                err=repr(e),
            )

    chat_log(
        "info",
        "chat_tool_flow_proposals_ok",
        project_id=project_id,
        session_id=session_id,
        mode=mode,
        flow_count=len(flows),
        flow_ids=[f.id for f in flows],
        flow_names=[f.name for f in flows],
        carried_over_count=sum(
            1 for f in flows if prior_flow_states.get(f.id) in ("approved", "rejected")
        ),
        new_active_message_id=inserted_id,
    )

    return {
        "inserted_flow_proposal_message_id": inserted_id,
        "active_flow_proposal_message_id": inserted_id,
        "research_report": research_report,
    }


# ----- tool: start_test_run -----


async def tool_start_test_run(state: ChatTurnState) -> dict[str, Any]:
    """Materialize approved flows into templates + a test_runs row + spawn Modal.

    Reads flows from the single active proposals row — rows flipped to
    `status='superseded'` are ignored, so approvals on historical cards
    (which the UI should already prevent via read-only mode) never
    leak into execution.
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

    # Re-read the active proposals row from the DB rather than trusting state,
    # so flows the user approved/rejected since the turn started are visible.
    active_row = _fetch_active_flow_proposals_row(sb, session_id)
    if active_row is None:
        return _start_test_run_failure(
            session_id,
            "Could not find active flow proposals for this session. Ask the user to "
            "generate proposals again, then approve flows before starting.",
        )

    latest_meta: dict[str, Any] = active_row.get("metadata") or {}

    flow_states = latest_meta.get("flow_states") or {}
    approved_ids = [fid for fid, s in flow_states.items() if s == "approved"]
    if not approved_ids:
        return _start_test_run_failure(
            session_id,
            "No approved flows on the active proposal set. The user needs to approve "
            "at least one flow before starting.",
        )

    proposals = latest_meta.get("proposals") or {}
    flows = proposals.get("flows") if isinstance(proposals, dict) else None
    if not isinstance(flows, list) or not flows:
        return _start_test_run_failure(
            session_id,
            "Could not find flow proposals for this session. Ask the user to "
            "generate proposals again, then approve flows before starting.",
        )

    approved_flows = [
        f for f in flows if isinstance(f, dict) and f.get("id") in approved_ids
    ]
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

    modal_call_id: str | None = None
    try:
        import modal

        fn = modal.Function.from_name("atlas-runner", "execute_test_run")
        call = fn.spawn(test_run_id, project_id)
        modal_call_id = call.object_id
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

    Extracts the final text from the most recent AIMessage. The
    `AIMessage.content` can be either a plain string (text-only turn) or a
    list of content blocks (text + tool_use interleaved). Gemini 3 series
    models always return a list of content blocks (one per thought-signed
    text span), so we concatenate only the text blocks.

    Idempotency: we upsert on `(session_id, client_message_id)` so a
    Modal retry or a duplicate spawn never duplicates the assistant row.
    """
    sb = get_supabase()
    session_id = state["session_id"]
    messages = state.get("messages") or []

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

    try:
        await maybe_summarize_older_messages(sb, session_id)
    except Exception as e:
        chat_log(
            "warn",
            "chat_finalize_summarize_failed",
            session_id=session_id,
            err=repr(e),
        )

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
