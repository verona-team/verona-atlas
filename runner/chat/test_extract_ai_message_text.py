"""Unit tests for `extract_ai_message_text`.

The helper is small but load-bearing: it's now shared between `agent_turn`
(which persists the opening text *before* any tool node runs so the DB
row ordering matches the model's content-block order) and `finalize`
(which keeps the same upsert as a safety-net fallback). Getting the
extraction wrong would either drop assistant text entirely or re-introduce
the reverse-ordering bug.

Runnable standalone from the repo root:

    python3 -m runner.chat.test_extract_ai_message_text
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SUPABASE_URL", "https://x")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "x")
os.environ.setdefault("ANTHROPIC_API_KEY", "x")

from langchain_core.messages import AIMessage

from runner.chat.nodes import extract_ai_message_text


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def test_plain_string_content() -> None:
    """Text-only reply: content is a string, returned as-is (trimmed)."""
    msg = AIMessage(content="  Hello there.  ")
    assert extract_ai_message_text(msg) == "Hello there."
    print(_green("  ok: plain string content is trimmed"))


def test_text_blocks_only() -> None:
    """A single text block wrapped in a list — common for text-only turns."""
    msg = AIMessage(content=[{"type": "text", "text": "Just text."}])
    assert extract_ai_message_text(msg) == "Just text."
    print(_green("  ok: single text block extracted"))


def test_text_then_tool_use() -> None:
    """The reverse-ordering bug's exact shape: text precedes tool_use.

    This is the content the orchestrator LLM emits on a bootstrap turn —
    it narrates ("Welcome — let me pull together the highest-priority
    test flows...") and then calls generate_flow_proposals. The extractor
    must return the text cleanly so agent_turn can persist it before the
    tool runs.
    """
    msg = AIMessage(
        content=[
            {
                "type": "text",
                "text": "Welcome — let me pull together the highest-priority test flows.",
            },
            {
                "type": "tool_use",
                "id": "toolu_abc",
                "name": "generate_flow_proposals",
                "input": {"mode": "bootstrap", "reason": "bootstrap turn"},
            },
        ]
    )
    assert (
        extract_ai_message_text(msg)
        == "Welcome — let me pull together the highest-priority test flows."
    )
    print(_green("  ok: text-then-tool_use extracts text, drops tool_use"))


def test_tool_use_only_no_text() -> None:
    """A pure tool call with no accompanying prose returns empty string.

    The orchestrator prompt tells the LLM it may emit a short opening
    sentence or skip it entirely; the empty-text case is legitimate.
    Returning "" lets callers skip the DB write without branching.
    """
    msg = AIMessage(
        content=[
            {
                "type": "tool_use",
                "id": "toolu_abc",
                "name": "start_test_run",
                "input": {"reason": "user confirmed"},
            },
        ]
    )
    assert extract_ai_message_text(msg) == ""
    print(_green("  ok: tool_use-only content returns empty string"))


def test_multiple_text_blocks_concatenated() -> None:
    """Two text blocks joined without an extra separator (rare in practice,
    but the helper must be deterministic)."""
    msg = AIMessage(
        content=[
            {"type": "text", "text": "First half. "},
            {"type": "text", "text": "Second half."},
        ]
    )
    assert extract_ai_message_text(msg) == "First half. Second half."
    print(_green("  ok: multiple text blocks concatenate in order"))


def test_interleaved_text_and_tool_use() -> None:
    """Text block BEFORE and AFTER a tool_use: both text fragments preserved."""
    msg = AIMessage(
        content=[
            {"type": "text", "text": "Pre-tool narration. "},
            {"type": "tool_use", "id": "t", "name": "x", "input": {}},
            {"type": "text", "text": "Post-tool trailing text."},
        ]
    )
    assert (
        extract_ai_message_text(msg)
        == "Pre-tool narration. Post-tool trailing text."
    )
    print(_green("  ok: text blocks surrounding a tool_use are both kept"))


def test_whitespace_only_text_returns_empty() -> None:
    """Text that trims to empty must return "" (not whitespace)."""
    msg = AIMessage(content=[{"type": "text", "text": "   \n  "}])
    assert extract_ai_message_text(msg) == ""
    print(_green("  ok: whitespace-only content returns empty string"))


def test_non_string_text_block_ignored() -> None:
    """Defensive: a text block where `text` is not a string is dropped,
    not crashed on. (Shouldn't happen in practice — real LLM providers
    always send strings — but guards against an upstream schema change.)"""
    msg = AIMessage(
        content=[
            {"type": "text", "text": 42},  # type: ignore[dict-item]
            {"type": "text", "text": "real text"},
        ]
    )
    assert extract_ai_message_text(msg) == "real text"
    print(_green("  ok: non-string text value is ignored defensively"))


def main() -> None:
    print("running extract_ai_message_text tests:")
    test_plain_string_content()
    test_text_blocks_only()
    test_text_then_tool_use()
    test_tool_use_only_no_text()
    test_multiple_text_blocks_concatenated()
    test_interleaved_text_and_tool_use()
    test_whitespace_only_text_returns_empty()
    test_non_string_text_block_ignored()
    print(_green("all tests passed"))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(_red(f"ASSERTION FAILED: {e}"))
        sys.exit(1)
    except Exception as e:
        import traceback

        print(_red(f"UNEXPECTED ERROR: {type(e).__name__}: {e}"))
        traceback.print_exc()
        sys.exit(2)
