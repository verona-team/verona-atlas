"""Nightly analysis pipeline — research + flow proposals + optional Slack notify.

Port of the inline logic in `app/api/cron/nightly/route.ts`. Differences:

- Always forces a research refresh (nightly's job is to catch what changed
  overnight — cached reports defeat the point).
- Optional Slack notification piggybacks on the existing slack integration
  config / `postMessage` helper (ported to Python via httpx).
- Writes the flow_proposals chat_messages row with a leading prefix that
  flags it as nightly vs. user-triggered.
"""
from __future__ import annotations

import os
from typing import Any

import httpx
from supabase import Client

from .flow_generator import (
    generate_flow_proposals as run_flow_generator,
    serialize_flows_for_message,
)
from .logging import chat_log
from .supabase_client import iso_now
from runner.encryption import decrypt


async def run_nightly_pipeline(sb: Client, project_id: str, *, turn_id: str) -> None:
    """Execute one nightly analysis for a single project.

    Side effects: writes research_report to chat_sessions, inserts a
    flow_proposals row in chat_messages, optionally posts to Slack.
    """
    from runner.research.orchestrator import run_research_agent

    # Load project.
    project_resp = (
        sb.table("projects")
        .select("id, name, app_url")
        .eq("id", project_id)
        .single()
        .execute()
    )
    project = project_resp.data
    if not project:
        chat_log("warn", "chat_nightly_project_missing", project_id=project_id)
        return

    app_url = project.get("app_url") or ""
    project_name = project.get("name") or ""

    # Ensure session exists (create if not — the cron may fire before any
    # user has opened the chat).
    #
    # Intentionally using .limit(1) without .maybe_single() because the
    # supabase-py maybe_single().execute() returns `None` (not a response
    # object with .data = None) when zero rows match, which would crash
    # on attribute access. Using the plain list form and indexing is the
    # version that's actually robust against 0/1 rows here.
    session_resp = (
        sb.table("chat_sessions")
        .select("id")
        .eq("project_id", project_id)
        .limit(1)
        .execute()
    )
    existing_sessions = session_resp.data or []
    if existing_sessions:
        session_id = existing_sessions[0]["id"]
    else:
        ins = (
            sb.table("chat_sessions")
            .insert({"project_id": project_id})
            .execute()
        )
        rows = ins.data or []
        if not rows:
            chat_log(
                "error", "chat_nightly_session_create_failed", project_id=project_id
            )
            return
        session_id = rows[0]["id"]

    # Always refresh research for nightly.
    chat_log(
        "info", "chat_nightly_research_begin", project_id=project_id, turn_id=turn_id
    )
    report = await run_research_agent(sb, project_id=project_id, app_url=app_url)
    report_json = report.model_dump(mode="json")

    try:
        sb.table("chat_sessions").update(
            {"research_report": report_json, "updated_at": iso_now()}
        ).eq("id", session_id).execute()
    except Exception as e:
        chat_log(
            "warn",
            "chat_nightly_persist_report_failed",
            project_id=project_id,
            err=repr(e),
        )

    # Nightly acts as a full "replace" — always supersedes any existing
    # active proposals row for this project's session, so users wake up
    # to one fresh set of cards rather than an accumulating stack. We
    # lazy-import the helpers from `nodes` to avoid an eager cycle (nodes
    # imports from flow_generator, which this module also imports).
    from .nodes import (
        _fetch_active_flow_proposals_row,
        _prior_summaries_from_row,
    )

    active_row = _fetch_active_flow_proposals_row(sb, session_id)
    prior_flow_summaries: list = []
    prior_flow_states: dict[str, str] = {}
    avoid_ids: list[str] = []
    if active_row is not None:
        (
            prior_flow_summaries,
            prior_flow_states,
            avoid_ids,
        ) = _prior_summaries_from_row(active_row)

    proposals = await run_flow_generator(
        app_url=app_url,
        research_report=report_json,
        prior_flows=prior_flow_summaries or None,
        avoid_ids=avoid_ids or None,
        intent=(
            "overnight analysis — regenerate from refreshed research; preserve any "
            "currently approved flows by re-emitting them verbatim, otherwise use "
            "all new ids"
            if active_row is not None
            else None
        ),
    )
    content, metadata, flows = serialize_flows_for_message(
        proposals,
        prior_flow_states=prior_flow_states or None,
        prior_flows=prior_flow_summaries or None,
        avoid_ids=avoid_ids or None,
    )

    inserted_id: str | None = None
    try:
        ins = (
            sb.table("chat_messages")
            .insert(
                {
                    "session_id": session_id,
                    "role": "assistant",
                    "content": f"Nightly analysis complete. {content}",
                    "metadata": metadata,
                }
            )
            .execute()
        )
        inserted_rows = ins.data or []
        if inserted_rows:
            inserted_id = inserted_rows[0].get("id")
    except Exception as e:
        chat_log(
            "error",
            "chat_nightly_persist_proposals_failed",
            project_id=project_id,
            err=repr(e),
        )
        return

    if active_row is not None and inserted_id is not None:
        try:
            prior_metadata = dict(active_row.get("metadata") or {})
            prior_metadata["status"] = "superseded"
            prior_metadata["superseded_by_message_id"] = inserted_id
            sb.table("chat_messages").update({"metadata": prior_metadata}).eq(
                "id", active_row["id"]
            ).execute()
        except Exception as e:
            chat_log(
                "error",
                "chat_nightly_supersede_failed",
                session_id=session_id,
                prior_message_id=active_row["id"],
                new_message_id=inserted_id,
                err=repr(e),
            )

    chat_log(
        "info",
        "chat_nightly_ok",
        project_id=project_id,
        session_id=session_id,
        turn_id=turn_id,
        flow_count=len(flows),
    )

    # Optional Slack notify.
    await _maybe_slack_notify(
        sb,
        project_id=project_id,
        project_name=project_name,
        report_summary=report_json.get("summary") or "",
        flow_count=len(flows),
    )


async def _maybe_slack_notify(
    sb: Client,
    *,
    project_id: str,
    project_name: str,
    report_summary: str,
    flow_count: int,
) -> None:
    """Post a summary to Slack if the project has a slack integration configured."""
    try:
        resp = (
            sb.table("integrations")
            .select("config")
            .eq("project_id", project_id)
            .eq("status", "active")
            .eq("type", "slack")
            .limit(1)
            .execute()
        )
        rows = resp.data or []
    except Exception as e:
        chat_log("warn", "chat_nightly_slack_fetch_failed", err=repr(e))
        return

    if not rows:
        return

    config: dict[str, Any] = rows[0].get("config") or {}
    bot_token_encrypted = config.get("bot_token_encrypted")
    channel_id = config.get("channel_id")
    if not bot_token_encrypted or not channel_id:
        return

    try:
        bot_token = decrypt(bot_token_encrypted)
    except Exception as e:
        chat_log("warn", "chat_nightly_slack_decrypt_failed", err=repr(e))
        return

    app_url_base = (os.environ.get("NEXT_PUBLIC_APP_URL") or "").rstrip("/")
    chat_url = f"{app_url_base}/projects/{project_id}/chat" if app_url_base else ""

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Verona* has suggested *{flow_count} new test flows* for "
                    f"*{project_name}*.\n\n{report_summary}"
                ),
            },
        }
    ]
    if chat_url:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"<{chat_url}|Review test flows in Verona ->>",
                },
            }
        )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            slack_resp = await client.post(
                "https://slack.com/api/chat.postMessage",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json={
                    "channel": channel_id,
                    "text": f"Verona: {flow_count} new test flows for {project_name}",
                    "blocks": blocks,
                },
            )
        body = slack_resp.json() if slack_resp.status_code == 200 else None
        if not body or not body.get("ok"):
            chat_log(
                "warn",
                "chat_nightly_slack_post_failed",
                status=slack_resp.status_code,
                body=str(body)[:200],
            )
    except Exception as e:
        chat_log("warn", "chat_nightly_slack_post_exception", err=repr(e))
