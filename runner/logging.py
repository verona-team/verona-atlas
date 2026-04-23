"""Structured JSON-line logging for the Modal runner.

Every log line emitted by our Modal functions goes through here so that
downstream log aggregation (Modal dashboard tail, shipped logs, etc.)
sees a uniform shape:

    {"ts": 1.7e9, "level": "info", "event": "snake_case_id",
     "source": "modal_<subsystem>", "project_id": "...", ...context...}

Two audiences:

1. **Live tail debugging in Modal.** Each line is a single JSON object on
   its own line, so `modal app logs` / the dashboard stream both render
   nicely AND the JSON is trivially grep-able (`rg '"event":"chat_turn_'`).

2. **Postmortem log search.** Since every line has `project_id` /
   `session_id` / `test_run_id` / `turn_id` keys where applicable, you
   can filter all lines for a single invocation with one predicate.

## Design

- `log_event()` is the primitive. It takes an event name, a level, a
  source tag, and arbitrary structured kwargs. It serializes safely
  (falls back to `repr()` for anything that isn't JSON-serializable) and
  NEVER raises — a broken log call must not take down a running test or
  chat turn.

- `bind()` returns a `BoundLogger` that pre-fills common context keys
  (project_id, test_run_id, etc.) so callers in hot paths don't have to
  repeat them. It also exposes `span()` — a context manager that logs
  `<event>_start` / `<event>_ok` / `<event>_failed` with elapsed timing
  so you can see at a glance which stage of a pipeline is slow or
  broken.

- Module-level convenience functions (`chat_log`, `test_log`) are thin
  wrappers with the right `source` tag baked in so the call sites read
  naturally.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from contextlib import contextmanager
from typing import Any, Iterator, Literal

Level = Literal["debug", "info", "warn", "error"]


def _serialize_extra(extra: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON-safe copy of *extra*.

    Values that json.dumps can't handle fall back to `repr()` so a bad
    payload never crashes the log call itself.
    """
    safe: dict[str, Any] = {}
    for k, v in extra.items():
        try:
            json.dumps(v, default=str)
            safe[k] = v
        except Exception:
            safe[k] = repr(v)
    return safe


def log_event(
    level: Level,
    event: str,
    *,
    source: str,
    **extra: Any,
) -> None:
    """Emit one structured log line to stdout.

    `event` should be a stable snake_case identifier (e.g. `test_run_begin`,
    `chat_tool_start_test_run_ok`). `source` tags the subsystem (e.g.
    `modal_chat_runner`, `modal_test_runner`) so cross-subsystem searches
    can filter cleanly.

    This function never raises; a last-resort stderr print is the
    fallback for total serialization failure.
    """
    payload: dict[str, Any] = {
        "ts": time.time(),
        "level": level,
        "event": event,
        "source": source,
    }
    payload.update(_serialize_extra(extra))
    try:
        print(json.dumps(payload, default=str), flush=True)
    except Exception as e:
        # Last-resort fallback: never let logging break execution.
        print(
            f"[log_event fallback] event={event} level={level} err={e!r}",
            file=sys.stderr,
            flush=True,
        )


class BoundLogger:
    """Logger with pre-bound context keys.

    Use `bind()` (below) to construct. Every call merges the bound keys
    with per-call kwargs, with per-call kwargs winning on conflict.
    """

    __slots__ = ("_source", "_context")

    def __init__(self, source: str, context: dict[str, Any]) -> None:
        self._source = source
        self._context = dict(context)

    def bind(self, **extra: Any) -> "BoundLogger":
        """Return a new logger with additional context keys bound."""
        merged = {**self._context, **extra}
        return BoundLogger(self._source, merged)

    def log(self, level: Level, event: str, **extra: Any) -> None:
        merged = {**self._context, **extra}
        log_event(level, event, source=self._source, **merged)

    def debug(self, event: str, **extra: Any) -> None:
        self.log("debug", event, **extra)

    def info(self, event: str, **extra: Any) -> None:
        self.log("info", event, **extra)

    def warn(self, event: str, **extra: Any) -> None:
        self.log("warn", event, **extra)

    def error(self, event: str, **extra: Any) -> None:
        self.log("error", event, **extra)

    @contextmanager
    def span(self, event: str, **extra: Any) -> Iterator["BoundLogger"]:
        """Log start/ok/failed for a block of work, with elapsed timing.

        Usage:

            with log.span("template_execute", template_id=tpl_id) as sp:
                ...do work, sp.info("step_ok", step=3)...

        On normal exit: emits `<event>_ok` at info level with
        `elapsed_s`. On exception: emits `<event>_failed` at error level
        with exception type/message and traceback, then re-raises.
        """
        t0 = time.time()
        self.info(f"{event}_start", **extra)
        try:
            yield self
        except BaseException as exc:
            elapsed = time.time() - t0
            self.error(
                f"{event}_failed",
                elapsed_s=round(elapsed, 3),
                err_type=type(exc).__name__,
                err=str(exc),
                traceback=traceback.format_exc(),
                **extra,
            )
            raise
        else:
            elapsed = time.time() - t0
            self.info(
                f"{event}_ok",
                elapsed_s=round(elapsed, 3),
                **extra,
            )


def bind(source: str, **context: Any) -> BoundLogger:
    """Create a logger for `source` with initial context keys bound."""
    return BoundLogger(source, context)


# ---------------------------------------------------------------------------
# Convenience wrappers used by the existing call sites.
# ---------------------------------------------------------------------------


def chat_log(
    level: Level,
    event: str,
    *,
    project_id: str | None = None,
    session_id: str | None = None,
    turn_id: str | None = None,
    **extra: Any,
) -> None:
    """Back-compat wrapper for the chat subsystem.

    Mirrors the original `runner.chat.logging.chat_log` signature so every
    existing call site keeps working; new code can use `bind()` instead
    for cleaner context propagation.
    """
    ctx: dict[str, Any] = {}
    if project_id is not None:
        ctx["project_id"] = project_id
    if session_id is not None:
        ctx["session_id"] = session_id
    if turn_id is not None:
        ctx["turn_id"] = turn_id
    log_event(level, event, source="modal_chat_runner", **ctx, **extra)


def test_log(
    level: Level,
    event: str,
    *,
    test_run_id: str | None = None,
    project_id: str | None = None,
    template_id: str | None = None,
    template_name: str | None = None,
    **extra: Any,
) -> None:
    """Structured log for the test-execution subsystem.

    Keys mirror the columns in `test_runs` / `test_templates` so logs
    can be joined back against the DB trivially (copy `test_run_id` into
    your query and the whole pipeline for that run is one filter).
    """
    ctx: dict[str, Any] = {}
    if test_run_id is not None:
        ctx["test_run_id"] = test_run_id
    if project_id is not None:
        ctx["project_id"] = project_id
    if template_id is not None:
        ctx["template_id"] = template_id
    if template_name is not None:
        ctx["template_name"] = template_name
    log_event(level, event, source="modal_test_runner", **ctx, **extra)
