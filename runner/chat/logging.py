"""Structured JSON-line logs for the chat turn runner.

Mirrors `lib/chat/server-log.ts` output shape so logs aggregated from Vercel
(API route) and Modal (turn runner) use the same `event` taxonomy and
`project_id` / `session_id` keys in any downstream log search.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Literal

Level = Literal["debug", "info", "warn", "error"]


def chat_log(
    level: Level,
    event: str,
    *,
    project_id: str | None = None,
    session_id: str | None = None,
    turn_id: str | None = None,
    **extra: Any,
) -> None:
    """Emit a single structured log line to stdout.

    `event` is a stable snake_case identifier (e.g. `chat_turn_started`,
    `chat_tool_flow_proposals_ok`). Extra keys are JSON-serialized as-is;
    unserializable values fall back to `repr()` so a bad log call doesn't
    crash the turn.
    """
    payload: dict[str, Any] = {
        "ts": time.time(),
        "level": level,
        "event": event,
        "source": "modal_chat_runner",
    }
    if project_id is not None:
        payload["project_id"] = project_id
    if session_id is not None:
        payload["session_id"] = session_id
    if turn_id is not None:
        payload["turn_id"] = turn_id
    for k, v in extra.items():
        try:
            json.dumps(v, default=str)
            payload[k] = v
        except Exception:
            payload[k] = repr(v)
    try:
        print(json.dumps(payload, default=str), flush=True)
    except Exception as e:
        # Last-resort fallback: never let logging break execution.
        print(
            f"[chat_log fallback] event={event} level={level} err={e!r}",
            file=sys.stderr,
            flush=True,
        )
