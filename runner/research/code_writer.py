"""Opus-backed code writer for the integration research sandbox.

When the research orchestrator calls `execute_code(purpose="...")`, the
tool doesn't ask the orchestrator to write Python itself. Instead it
delegates to this module, which asks **Claude Opus 4.6** to produce a
focused Python snippet for that specific purpose, given:

- The provider API docs (same ones in the orchestrator's prompt).
- The env-var catalog (what creds/hosts are preloaded in the sandbox).
- A one-call-back summary of the previous exec (for self-correction when
  the previous script had a bug like `KeyError`).

## Why split this out of the orchestrator

The orchestrator's job is deciding **what to investigate** — scanning
preflight signal, correlating across providers, choosing the next
question. Mixing that with code generation has two costs:

1. **Context bloat.** Every prior tool call appends `(AIMessage with
   full code string) + (ToolMessage with stdout)` to the orchestrator's
   messages. Over 20 steps that's meaningful token weight on Sonnet
   that has nothing to do with routing decisions.
2. **Quality.** Opus writes substantially better Python for non-trivial
   tasks (HogQL with joins, GitHub pagination, LangSmith session-first
   run queries) than Sonnet. Using Sonnet for "decide what to ask" +
   Opus for "write the code" plays to both models' strengths.

## Statelessness

The code writer is stateless per call. It receives:
- `purpose` — the natural-language instruction from the orchestrator.
- `docs` — full provider docs bundle.
- `env_description` — human-readable env var catalog.
- `previous_exec` — optional `{purpose, exit_code, stderr_head}` from
  the immediately preceding call so it can fix its own bugs without
  the orchestrator having to narrate.

No cumulative history. Every call is a fresh, bounded prompt. This
keeps the code writer fast and predictable.

## Output shape

`with_structured_output(CodeWriterOutput)` forces Opus to emit
`{code: str, explanation: str}` — no markdown fences, no preamble.
`explanation` is surfaced back to the orchestrator in the tool result
so it can see what the code writer actually produced and correct course
("you wrote a POST but I wanted a GET") on the next call.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from runner.chat.logging import chat_log
from runner.chat.models import get_opus


class CodeWriterOutput(BaseModel):
    """Schema forcing the code writer to emit clean, parseable output."""

    code: str = Field(
        description=(
            "Executable Python 3.13 source code. NO markdown fences, NO "
            "commentary, NO '```python' prefix. Just the raw script. "
            "MUST print JSON to stdout via `print(json.dumps(...))`. "
            "MUST read credentials from os.environ, never from literals."
        )
    )
    explanation: str = Field(
        description=(
            "One short sentence (<=25 words) describing what this script "
            "does and what it expects in stdout. This goes back to the "
            "orchestrator as part of the tool result."
        )
    )


class PreviousExec(BaseModel):
    """Compact summary of the previous execute_code call.

    Used so the code writer can self-correct (e.g. 'the last script hit
    a KeyError — use .get() this time'). Deliberately NOT a full history;
    we only carry one call's worth of context backward so the code
    writer stays focused.
    """

    purpose: str
    exit_code: int
    stderr_head: str  # first ~1000 chars of stderr, if any


_SYSTEM_PROMPT = """You are a Python 3.13 code generator for a QA research investigator. You receive natural-language research goals and produce focused httpx scripts that answer them.

# Execution environment

The code you produce runs inside a Modal Sandbox with:
- Python 3.13
- httpx (sync API preinstalled)
- Stdlib only beyond that (json, os, datetime, collections, re, itertools, urllib.parse, etc.)
- A 60 second timeout per exec
- Fresh process every call — no state survives between calls
- Open outbound network
- Environment variables preloaded with integration credentials and config (listed below)

# Auth headers you must set yourself

- **GitHub**: `Authorization: token ${GITHUB_INSTALLATION_TOKEN}`, `Accept: application/vnd.github.v3+json`, `X-GitHub-Api-Version: 2022-11-28`. Base: `https://api.github.com`. `GITHUB_REPO` is `owner/repo`.
- **PostHog**: `Authorization: Bearer ${POSTHOG_API_KEY}`. Base: `$POSTHOG_HOST`. Project id: `$POSTHOG_PROJECT_ID`.
- **Sentry**: `Authorization: Bearer ${SENTRY_AUTH_TOKEN}`. Base: `https://sentry.io/api/0`. Org: `$SENTRY_ORG_SLUG`, project: `$SENTRY_PROJECT_SLUG`.
- **LangSmith**: `X-API-Key: ${LANGSMITH_API_KEY}`. Base: `https://api.smith.langchain.com`. Project (optional): `$LANGSMITH_PROJECT_NAME`.
- **Braintrust**: `Authorization: Bearer ${BRAINTRUST_API_KEY}`. Base: `https://api.braintrust.dev`.

# Non-negotiable code rules

1. **Read credentials from `os.environ` only.** Never hardcode tokens/keys.
2. **Print JSON to stdout as your ONLY output:** `print(json.dumps(result, default=str, indent=2))`. The caller parses stdout as JSON.
3. **Wrap HTTP calls in try/except.** Surface 4xx/5xx bodies into the JSON result under an `"error"` key — don't let the script crash with an unhandled ClientResponseError.
4. **Stay focused.** One script answers one question. Don't sprawl. If the orchestrator wanted five things, they'd have called you five times.
5. **Be defensive with nested dict access.** Prefer `.get(key, default)` over `dict[key]`. API responses change shape across providers; crashing on a missing field wastes a turn.
6. **Keep output compact.** If a response has 500 items, filter/slice before printing — ~100 items is the sweet spot. The caller has limited context window.
7. **No markdown, no prose in your output.** Your `code` field is the raw script. Your `explanation` field is ONE short sentence.

# What good code looks like

```
import json
import os
import httpx

token = os.environ["GITHUB_INSTALLATION_TOKEN"]
repo = os.environ["GITHUB_REPO"]
headers = {
    "Authorization": f"token {token}",
    "Accept": "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

try:
    with httpx.Client(timeout=30) as client:
        resp = client.get(
            f"https://api.github.com/repos/{repo}/pulls/206/files",
            headers=headers,
            params={"per_page": 100},
        )
        resp.raise_for_status()
        files = resp.json()
    out = [
        {"filename": f.get("filename"), "status": f.get("status"),
         "additions": f.get("additions"), "deletions": f.get("deletions")}
        for f in files
    ]
    print(json.dumps({"pr": 206, "file_count": len(out), "files": out[:50]}, default=str))
except httpx.HTTPError as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
```

Notice: env-var auth, try/except around HTTP, compact JSON result, no markdown, no explanation embedded in the code.

# Self-correction

If the caller includes a `previous_exec` summary showing a non-zero exit code, address the specific failure in your new script (e.g., wrong field name, missing query param, pagination needed). Don't just retry blindly."""


def _build_user_message(
    *,
    purpose: str,
    docs_block: str,
    env_description: str,
    previous_exec: PreviousExec | None,
) -> str:
    sections: list[str] = [
        "# Research goal",
        purpose,
        "",
        "# Env vars available inside the sandbox",
        env_description,
        "",
        "# Provider API reference",
        docs_block,
    ]

    if previous_exec is not None and previous_exec.exit_code != 0:
        sections.extend(
            [
                "",
                "# Previous exec failed — fix the specific problem before producing new code",
                f"Previous purpose: {previous_exec.purpose}",
                f"Previous exit code: {previous_exec.exit_code}",
                f"Previous stderr (first 1000 chars):",
                previous_exec.stderr_head or "(empty)",
            ]
        )

    sections.extend(
        [
            "",
            "Produce the Python script now. Output only the CodeWriterOutput "
            "schema — raw `code` (no markdown fences) and a one-sentence `explanation`.",
        ]
    )
    return "\n".join(sections)


async def write_research_code(
    *,
    purpose: str,
    docs_block: str,
    env_description: str,
    previous_exec: PreviousExec | None = None,
) -> CodeWriterOutput:
    """Ask Opus to produce Python that fulfills the given research goal.

    Always returns a `CodeWriterOutput`. If Opus errors or returns
    unusable output (empty code, obvious truncation), we still return a
    valid `CodeWriterOutput` whose `code` is a stub that prints an
    informative error to stdout — this keeps the outer ReAct loop
    unblocked rather than crashing a whole research run on one bad
    generation.
    """
    chat_log(
        "info",
        "research_code_writer_begin",
        purpose=purpose[:200],
        has_previous_exec=previous_exec is not None,
        previous_failed=(
            previous_exec is not None and previous_exec.exit_code != 0
        ),
    )

    model = get_opus(max_tokens=4096, temperature=0.1)
    structured = model.with_structured_output(CodeWriterOutput, method="json_schema")

    user_message = _build_user_message(
        purpose=purpose,
        docs_block=docs_block,
        env_description=env_description,
        previous_exec=previous_exec,
    )

    try:
        output: CodeWriterOutput = await structured.ainvoke(
            [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ]
        )
    except Exception as e:
        chat_log("error", "research_code_writer_llm_failed", err=repr(e))
        return _error_stub(
            f"Opus refused to generate code for purpose {purpose!r}: "
            f"{type(e).__name__}: {e}"
        )

    if not output.code.strip():
        chat_log("warn", "research_code_writer_empty_output", purpose=purpose[:200])
        return _error_stub(
            f"Opus returned empty code for purpose {purpose!r}."
        )

    # Sometimes models ignore instructions and wrap output in markdown
    # fences despite the schema. Strip defensively; if we stripped
    # anything, log it so we can tighten the prompt later.
    cleaned = _strip_markdown_fences(output.code)
    if cleaned != output.code:
        chat_log(
            "warn",
            "research_code_writer_stripped_fences",
            purpose=purpose[:200],
            before_len=len(output.code),
            after_len=len(cleaned),
        )
        output = CodeWriterOutput(code=cleaned, explanation=output.explanation)

    chat_log(
        "info",
        "research_code_writer_ok",
        purpose=purpose[:200],
        code_length=len(output.code),
        explanation=output.explanation,
    )
    return output


def _strip_markdown_fences(code: str) -> str:
    """Remove leading/trailing ```python ... ``` fences if Opus added them."""
    stripped = code.strip()
    if stripped.startswith("```"):
        # Drop the opening fence line.
        first_newline = stripped.find("\n")
        if first_newline >= 0:
            stripped = stripped[first_newline + 1 :]
        else:
            stripped = stripped.removeprefix("```python").removeprefix("```")
    if stripped.endswith("```"):
        stripped = stripped[: -len("```")].rstrip()
    return stripped


def _error_stub(message: str) -> CodeWriterOutput:
    """Build a valid CodeWriterOutput whose code prints the error to stdout.

    The outer ReAct loop treats any non-zero exit as recoverable, so by
    producing a script that prints-and-exits-non-zero we let the loop
    continue and the orchestrator see what went wrong without us having
    to distinguish "code writer failed" from "sandbox exec failed" at
    the loop level.
    """
    # Keep the generated code trivial and dependency-free so it can't
    # fail for unrelated reasons.
    safe_message = message.replace('"""', "'''")
    code = (
        "import json, sys\n"
        f'payload = {{"error": "code_writer_failed", "message": """{safe_message}"""}}\n'
        "print(json.dumps(payload))\n"
        "sys.exit(1)\n"
    )
    return CodeWriterOutput(code=code, explanation="Code writer failure stub.")
