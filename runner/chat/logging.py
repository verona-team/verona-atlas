"""Chat-subsystem structured logging.

Thin re-export of the generic `runner.logging` module so existing call
sites (`from runner.chat.logging import chat_log`) keep working. New
code in either subsystem should prefer `runner.logging.bind(...)` for
context-bound loggers with span-timing support.
"""
from __future__ import annotations

from runner.logging import chat_log, bind, log_event, BoundLogger

__all__ = ["chat_log", "bind", "log_event", "BoundLogger"]
