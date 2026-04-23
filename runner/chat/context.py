"""Conversation context management: rolling summary of older messages.

Port of `lib/chat/context.ts`. Called from the finalize node to
compress older messages into a persistent `chat_sessions.context_summary`
once the message count crosses a threshold, then hard-delete the rolled-up
rows. Keeps the per-turn token bill bounded for long-lived sessions.

Uses Claude Sonnet 4.6 (cheap + fast for summarization).
"""
from __future__ import annotations

from typing import Any

from supabase import Client

from .logging import chat_log
from .models import get_sonnet


RECENT_MESSAGE_LIMIT = 30
SUMMARIZE_THRESHOLD = 50


async def maybe_summarize_older_messages(sb: Client, session_id: str) -> None:
    """Compress older messages into `chat_sessions.context_summary` if needed.

    No-ops when the session has fewer than `SUMMARIZE_THRESHOLD` messages.
    Otherwise:

    1. Pull all messages in order.
    2. Take everything except the most recent `RECENT_MESSAGE_LIMIT`.
    3. Merge with the existing summary via a Sonnet call.
    4. Write the new summary and delete the summarized rows.

    Errors are logged but not raised — summarization is best-effort; failing
    to summarize does not break the turn.
    """
    try:
        count_resp = (
            sb.table("chat_messages")
            .select("id", count="exact", head=True)
            .eq("session_id", session_id)
            .execute()
        )
        count = count_resp.count or 0
    except Exception as e:
        chat_log("warn", "chat_summarize_count_failed", session_id=session_id, err=repr(e))
        return

    if count < SUMMARIZE_THRESHOLD:
        return

    try:
        all_resp = (
            sb.table("chat_messages")
            .select("id, role, content")
            .eq("session_id", session_id)
            .order("created_at", desc=False)
            .execute()
        )
        all_messages: list[dict[str, Any]] = all_resp.data or []
    except Exception as e:
        chat_log("warn", "chat_summarize_fetch_failed", session_id=session_id, err=repr(e))
        return

    if len(all_messages) < SUMMARIZE_THRESHOLD:
        return

    to_summarize = all_messages[:-RECENT_MESSAGE_LIMIT] if len(all_messages) > RECENT_MESSAGE_LIMIT else []
    if not to_summarize:
        return

    try:
        session_resp = (
            sb.table("chat_sessions")
            .select("context_summary")
            .eq("id", session_id)
            .single()
            .execute()
        )
        existing_summary = (session_resp.data or {}).get("context_summary") or ""
    except Exception as e:
        chat_log(
            "warn", "chat_summarize_session_fetch_failed", session_id=session_id, err=repr(e)
        )
        existing_summary = ""

    conversation_text = "\n".join(
        f"[{m.get('role')}]: {m.get('content') or ''}" for m in to_summarize
    )

    prompt = f"""You are compressing an older portion of a QA testing chat into a durable context summary. A future session will read only this summary (not the raw messages) to stay consistent with prior decisions.

# Must preserve

- Test flows proposed, and for each: whether it was approved, rejected, edited, or superseded — plus the reason if given.
- User preferences (e.g. "always include auth smoke test", "skip enterprise flows", "test production only").
- Explicit testing-strategy instructions from the user.
- Outcomes of past test runs discussed (pass/fail, notable failures, follow-ups).
- Open questions or TODOs the user asked to come back to.

# Drop

- Pleasantries, acknowledgements, filler.
- Research-report recitations — those are re-injected separately each turn.
- Step-by-step details of flows; reference by name and priority only.

# Output rules

- Plain prose with short labeled sections ("Flows:", "Preferences:", "Open items:"). No markdown headings beyond that.
- Keep under 1000 words. Be concrete — names, IDs, numbers — not narrative.
- If a previous summary exists, MERGE with it: update superseded facts, keep still-valid facts, drop anything the new messages resolved.

{f"# Previous summary{chr(10)}{existing_summary}{chr(10)}{chr(10)}" if existing_summary else ""}# New messages to incorporate
{conversation_text}"""

    try:
        model = get_sonnet(max_tokens=2048, temperature=0.1)
        response = await model.ainvoke(prompt)
        new_summary = (response.content or "").strip() if isinstance(response.content, str) else ""
        # Sonnet may return list content blocks for tool-aware responses;
        # fallback to join those when plain string unavailable.
        if not new_summary and isinstance(response.content, list):
            new_summary = "\n".join(
                str(b.get("text", "")) if isinstance(b, dict) else str(b)
                for b in response.content
            ).strip()
    except Exception as e:
        chat_log("error", "chat_summarize_llm_failed", session_id=session_id, err=repr(e))
        return

    if not new_summary:
        return

    try:
        sb.table("chat_sessions").update(
            {
                "context_summary": new_summary,
                "updated_at": "now()",  # supabase accepts the string literal
            }
        ).eq("id", session_id).execute()
    except Exception as e:
        chat_log(
            "error", "chat_summarize_update_failed", session_id=session_id, err=repr(e)
        )
        return

    try:
        ids_to_delete = [m["id"] for m in to_summarize if m.get("id")]
        if ids_to_delete:
            sb.table("chat_messages").delete().in_("id", ids_to_delete).execute()
    except Exception as e:
        chat_log(
            "error",
            "chat_summarize_delete_old_failed",
            session_id=session_id,
            err=repr(e),
            rollup_count=len(ids_to_delete) if "ids_to_delete" in locals() else 0,
        )
