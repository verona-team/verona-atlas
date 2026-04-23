"""Service-role Supabase client for Modal-side chat persistence.

Kept tiny and explicit so every caller sees the same contract:

- Always service role (bypasses RLS — we are the server).
- Created lazily per-process; the Supabase client is cheap to construct
  but there's no reason to keep re-creating it within a single turn.
- All reads/writes against tables the React UI renders from MUST use
  this client, so we never accidentally hit RLS-protected paths.
"""
from __future__ import annotations

import os
from typing import Any

from supabase import Client, create_client


_client: Client | None = None


def get_supabase() -> Client:
    """Return the singleton service-role Supabase client.

    Raises if env vars are missing — this is intentional; we want a
    fast, loud failure at container start rather than silently writing
    to nowhere.
    """
    global _client
    if _client is None:
        url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            raise RuntimeError(
                "Missing Supabase service-role credentials "
                "(SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)"
            )
        _client = create_client(url, key)
    return _client


def iso_now() -> str:
    """ISO-8601 UTC timestamp string for Supabase TIMESTAMPTZ columns."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def set_session_status(
    sb: Client,
    session_id: str,
    status: str,
    *,
    clear_active_call: bool = False,
    extra: dict[str, Any] | None = None,
) -> None:
    """Update chat_sessions status (and optionally clear the active Modal call).

    Kept here rather than inline because both the happy path (finalize node)
    and the emergency path (Modal function `finally` block) need the exact
    same shape.
    """
    payload: dict[str, Any] = {
        "status": status,
        "status_updated_at": iso_now(),
    }
    if clear_active_call:
        payload["active_chat_call_id"] = None
        payload["active_chat_call_started_at"] = None
    if extra:
        payload.update(extra)
    sb.table("chat_sessions").update(payload).eq("id", session_id).execute()
