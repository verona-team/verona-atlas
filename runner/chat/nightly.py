"""Scheduled nightly-analysis runner.

Mirrors the old Next.js cron body (`app/api/cron/nightly/route.ts`) but
runs in Modal so the cron handler can be a thin spawn + return.

The nightly job does:

1. Refresh the research report for the project (always refresh; the whole
   point of the cron is to catch what changed overnight).
2. Generate new flow proposals from that report.
3. Insert a chat_messages row with `metadata.type = 'flow_proposals'` so
   it shows up in the UI the next time the user opens the project.
4. Optionally Slack-notify the team.
"""
from __future__ import annotations

import secrets
import traceback

from .logging import chat_log
from .supabase_client import get_supabase


async def run_nightly_job(project_id: str) -> None:
    """Run the nightly analysis pipeline for a single project.

    Errors are logged and surfaced through Modal's function-call status.
    We deliberately do NOT write an error assistant message to the chat —
    unlike a user-triggered turn, nightly failure is not user-visible and
    spamming the chat with "cron failed" bubbles would be noisy.
    """
    sb = get_supabase()
    turn_id = f"nightly_{secrets.token_hex(6)}"

    chat_log("info", "chat_nightly_started", project_id=project_id, turn_id=turn_id)

    try:
        # Lazy import keeps deploy-time import graph shallow. Real pipeline
        # lands in Phase 5.
        from .nightly_pipeline import run_nightly_pipeline

        await run_nightly_pipeline(sb, project_id, turn_id=turn_id)

        chat_log("info", "chat_nightly_ok", project_id=project_id, turn_id=turn_id)

    except Exception as exc:
        chat_log(
            "error",
            "chat_nightly_failed",
            project_id=project_id,
            turn_id=turn_id,
            err=repr(exc),
            traceback=traceback.format_exc(),
        )
        raise
