"""Regression tests for build_initial_state's user-message handling.

Validates the fix for the production crash where Python's SELECT against
`chat_messages` came back empty (row not yet visible to the reader that
picked up the spawn) and the resulting single-system-message LLM call
400'd with "messages: at least one message is required".

The new contract passes `user_message_text` as a function argument, so
`build_initial_state` no longer depends on the DB read including the
current turn's row.

Runnable standalone from the repo root:

    python -m runner.chat.test_build_initial_state
"""
from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

os.environ.setdefault("SUPABASE_URL", "https://x")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")

from langchain_core.messages import HumanMessage

from runner.chat.state import build_initial_state


class _Resp:
    def __init__(self, data: Any) -> None:
        self.data = data


class _Query:
    """Stub for supabase-py's fluent query builder.

    Matches on the last `.table(<name>)` call to pick which response to
    return. The script is a dict of table_name -> list-of-responses,
    and `.execute()` pops the next response in sequence.
    """

    def __init__(self, client: "_FakeClient", table: str) -> None:
        self._client = client
        self._table = table

    def select(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def eq(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def order(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def limit(self, *_a: Any, **_kw: Any) -> "_Query":
        return self

    def single(self) -> "_Query":
        return self

    def execute(self) -> _Resp:
        self._client.calls += 1
        queue = self._client.script.get(self._table, [])
        if not queue:
            return _Resp(None)
        return _Resp(queue.pop(0))


class _FakeClient:
    """Minimum shape of supabase-py.Client we touch in build_initial_state."""

    def __init__(self, script: dict[str, list[Any]]) -> None:
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = 0

    def table(self, name: str) -> _Query:
        return _Query(self, name)


def _base_script(*, messages_response: list[dict[str, Any]] | None) -> dict[str, list[Any]]:
    """A script that satisfies every SELECT build_initial_state issues.

    `messages_response` controls what the chat_messages listing returns;
    everything else is a realistic minimum so the function can build a
    full state dict.
    """
    return {
        "chat_sessions": [
            [
                {
                    "id": "sess",
                    "context_summary": None,
                    "research_report": {"dummy": "cached"},
                    "project_id": "proj",
                    "status": "thinking",
                }
            ]
        ],
        "projects": [
            [{"id": "proj", "name": "Acme", "app_url": "https://acme.test"}]
        ],
        "chat_messages": [messages_response if messages_response is not None else []],
        "test_runs": [[]],
        "integrations": [[]],
    }


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


async def test_empty_history_uses_arg_text() -> None:
    """The regression case: DB listing returned nothing, arg text alone drives the LLM."""
    sb = _FakeClient(_base_script(messages_response=[]))

    state = await build_initial_state(
        sb,  # type: ignore[arg-type]
        session_id="sess",
        project_id="proj",
        user_message_client_id="uabc",
        user_message_text="hello verona",
        turn_id="t",
    )

    msgs = state["messages"]
    assert len(msgs) == 1, f"expected 1 message, got {len(msgs)}"
    assert isinstance(msgs[0], HumanMessage)
    assert msgs[0].content == "hello verona"
    print(_green("  ok: empty listing + arg text => single HumanMessage"))


async def test_history_plus_arg_text() -> None:
    """Prior turns + current turn arg compose into full history."""
    sb = _FakeClient(
        _base_script(
            messages_response=[
                # DESC order (newest first), function reverses
                {
                    "id": "m3",
                    "role": "assistant",
                    "content": "sure, try X",
                    "client_message_id": "va_prev_asst",
                    "metadata": None,
                    "created_at": "2026-04-23T00:02:00Z",
                },
                {
                    "id": "m2",
                    "role": "user",
                    "content": "what do I do next?",
                    "client_message_id": "u_prev_user",
                    "metadata": None,
                    "created_at": "2026-04-23T00:01:00Z",
                },
            ]
        )
    )

    state = await build_initial_state(
        sb,  # type: ignore[arg-type]
        session_id="sess",
        project_id="proj",
        user_message_client_id="u_current",
        user_message_text="follow-up question",
        turn_id="t",
    )

    msgs = state["messages"]
    assert len(msgs) == 3, f"expected 3 msgs, got {len(msgs)}"
    assert msgs[0].content == "what do I do next?"
    assert msgs[1].content.startswith("[previous assistant reply]")  # type: ignore[union-attr]
    assert msgs[2].content == "follow-up question"
    print(_green("  ok: history + current turn arg compose in chronological order"))


async def test_current_turn_in_listing_is_deduped() -> None:
    """If the listing DID include the current row, we skip it (use the arg)."""
    sb = _FakeClient(
        _base_script(
            messages_response=[
                {
                    "id": "m1",
                    "role": "user",
                    "content": "will be deduped",
                    "client_message_id": "u_current",
                    "metadata": None,
                    "created_at": "2026-04-23T00:01:00Z",
                }
            ]
        )
    )

    state = await build_initial_state(
        sb,  # type: ignore[arg-type]
        session_id="sess",
        project_id="proj",
        user_message_client_id="u_current",
        user_message_text="authoritative text",
        turn_id="t",
    )

    msgs = state["messages"]
    assert len(msgs) == 1, f"expected 1 msg, got {len(msgs)}"
    assert msgs[0].content == "authoritative text", (
        "expected arg text, not DB text (arg is the source of truth)"
    )
    print(_green("  ok: current-turn row in listing is deduped; arg wins"))


async def test_empty_arg_logs_but_does_not_crash() -> None:
    """Defensive: empty arg is an upstream bug but we want a loud log, not a crash here."""
    sb = _FakeClient(_base_script(messages_response=[]))
    state = await build_initial_state(
        sb,  # type: ignore[arg-type]
        session_id="sess",
        project_id="proj",
        user_message_client_id="u_current",
        user_message_text="",
        turn_id="t",
    )
    msgs = state["messages"]
    assert msgs == [], "expected empty messages list when arg is empty"
    # The log event "chat_user_message_text_empty" gets emitted; the
    # agent would still 400 downstream if we reached it, but that's a
    # programming error on the API route side — not a race we need to
    # mask over in build_initial_state itself.
    print(_green("  ok: empty arg logs loudly, returns empty messages"))


async def _run_all() -> None:
    print("running build_initial_state regression tests:")
    await test_empty_history_uses_arg_text()
    await test_history_plus_arg_text()
    await test_current_turn_in_listing_is_deduped()
    await test_empty_arg_logs_but_does_not_crash()
    print(_green("all tests passed"))


if __name__ == "__main__":
    try:
        asyncio.run(_run_all())
    except AssertionError as e:
        print(_red(f"ASSERTION FAILED: {e}"))
        sys.exit(1)
    except Exception as e:
        import traceback

        print(_red(f"UNEXPECTED ERROR: {type(e).__name__}: {e}"))
        traceback.print_exc()
        sys.exit(2)
