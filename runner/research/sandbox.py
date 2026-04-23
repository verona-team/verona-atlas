"""Modal Sandbox for arbitrary LLM-written integration research code.

The integration research agent lets Claude drill deep into each connected
integration by writing ad-hoc Python that calls the provider's API. Running
that Python inside a Modal Sandbox buys us:

- **Isolation.** LLM-generated code can do whatever it wants within the
  sandbox's gVisor container without touching our Modal function's process
  or secrets-outside-the-integration-scope.
- **Ephemerality.** Sandboxes are bounded (10min here) and torn down at
  the end of every research run; leaked state is impossible.
- **Reproducibility.** The sandbox image is pinned (`debian_slim(py=3.13)`
  + `httpx`), so Claude's code sees the same runtime every invocation.

## Design choices

- **Language inside the sandbox: Python.** The old TS agent had Claude
  write JS because Vercel Sandbox was Node. We're free to pick, and
  Python wins for us because our whole runner is Python and Claude
  writes idiomatic httpx calls with less ceremony than `fetch`.

- **Credentials via env vars, not injected headers.** The old Vercel
  Sandbox had host-scoped `transform.headers` allow-list magic that
  silently injected auth headers on outbound requests to allowed hosts.
  Modal doesn't have an equivalent, so instead we:
    1. Decrypt credentials in the parent process.
    2. Pass them as env vars to the sandbox via `Secret.from_dict`.
    3. Tell Claude exactly which env var → which header in the system
       prompt (e.g. `Authorization: Bearer $POSTHOG_API_KEY`).
  This is actually cleaner — the LLM sees what it's using and we can
  check the generated code for anything suspicious before it runs (we
  don't bother, but we could).

- **Network policy: default (open).** `block_network=True` would break
  the whole point. `cidr_allowlist` is IP-based, which is fragile
  against CDN-fronted integration hosts (PostHog, Sentry, etc. rotate
  IPs constantly). We rely on (a) sandbox ephemerality (≤10min), (b)
  the LLM being system-prompted with allowed hosts, (c) tight
  credential scoping (only the user's own integration keys are
  in-scope). Net security posture is comparable to the old Vercel
  Sandbox for our threat model.

- **One sandbox per research run, shared across all tool calls.**
  `Sandbox.create` takes a few seconds; amortizing that across the
  ~20 execute_code calls per run is worth it. Creates at the start
  of `run_integration_research`, terminates + detaches in `finally`.

- **`exec("python", "-c", code)` instead of writing files.** On Linux
  ARG_MAX is ~2MB — plenty for any LLM-written research script. Skips
  the filesystem round-trip and makes the exec strictly 1:1 with the
  tool call, which simplifies log correlation.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import modal

from runner.chat.logging import chat_log


# The Modal App that hosts our research sandboxes. We use the same
# atlas-runner app as the chat functions so everything is grouped in one
# place in the Modal dashboard; the name distinguishes Sandboxes from
# Functions in listings.
_SANDBOX_APP_NAME = "atlas-runner"

# Per-sandbox timeout. Generous enough for a ~20-step ReAct loop with
# real HTTP latency to PostHog/Sentry/etc., tight enough that a stuck
# sandbox can't rack up a large bill.
_SANDBOX_TIMEOUT_S = 600

# Per-exec timeout. One `execute_code` call should never take more than
# a minute — any single HTTP request is sub-second; 60s allows for
# pagination loops while still catching infinite loops in LLM code.
_EXEC_TIMEOUT_S = 60


@dataclass
class IntegrationEnv:
    """Environment variables to inject into the research sandbox.

    Kept as a typed dataclass rather than `dict[str, str]` so it's
    obvious what shape the downstream sandbox will see; the values
    here are exactly what ends up in `os.environ` inside Claude's
    execute_code calls.
    """

    # Non-secret configuration (host URLs, project IDs, org slugs).
    # These end up in the sandbox env as plain vars — not secrets,
    # because they're not sensitive.
    public: dict[str, str]
    # Decrypted credentials. Passed via modal.Secret.from_dict so
    # they're never logged by Modal's own instrumentation (though
    # Claude's code can obviously read them from os.environ — that's
    # the whole point).
    secret: dict[str, str]

    def describe(self) -> str:
        """Human-readable list of env vars (secrets shown as keys only)."""
        lines: list[str] = []
        for k, v in self.public.items():
            lines.append(f"  {k}={v}")
        for k in self.secret:
            lines.append(f"  {k}=***")
        return "\n".join(lines) or "  (none)"


@dataclass
class ExecResult:
    """Outcome of one `execute_code` tool call."""

    exit_code: int
    stdout: str
    stderr: str


def _build_sandbox_image() -> modal.Image:
    """Debian slim + httpx. Cached across runs once Modal has built it once.

    We intentionally keep the dependency list minimal. Claude's research
    scripts only need to speak HTTPS; anything heavier (pandas etc.)
    would bloat cold starts with zero research-agent benefit.
    """
    return modal.Image.debian_slim(python_version="3.13").pip_install(
        "httpx>=0.28.0,<1.0.0"
    )


def create_research_sandbox(env: IntegrationEnv) -> modal.Sandbox:
    """Spawn a fresh Modal Sandbox for a single research run.

    Caller MUST pair this with `teardown_sandbox(sb)` in a finally
    block — sandboxes are charged until terminated, and detach is
    required to clean up the local gRPC connection.

    The sandbox runs with default network policy (open outbound).
    See the module docstring for the rationale.
    """
    app = modal.App.lookup(_SANDBOX_APP_NAME, create_if_missing=True)
    image = _build_sandbox_image()

    secrets: list[modal.Secret] = []
    if env.secret:
        secrets.append(modal.Secret.from_dict(env.secret))

    chat_log(
        "info",
        "research_sandbox_create",
        public_env_keys=list(env.public.keys()),
        secret_env_keys=list(env.secret.keys()),
        timeout_s=_SANDBOX_TIMEOUT_S,
    )

    sb = modal.Sandbox.create(
        app=app,
        image=image,
        env=env.public if env.public else None,
        secrets=secrets or None,
        timeout=_SANDBOX_TIMEOUT_S,
    )
    chat_log("info", "research_sandbox_created", sandbox_id=sb.object_id)
    return sb


def execute_in_sandbox(sb: modal.Sandbox, code: str) -> ExecResult:
    """Run a snippet of Python inside the sandbox, return (exit_code, stdout, stderr).

    Uses `python -c` so the script is passed inline (no filesystem round
    trip, no script-name collisions between parallel calls). On ARG_MAX
    grounds we cap the code at 1.5MB here — anything larger indicates a
    prompt or loop bug, not legitimate research code.
    """
    MAX_CODE_CHARS = 1_500_000
    if len(code) > MAX_CODE_CHARS:
        return ExecResult(
            exit_code=1,
            stdout="",
            stderr=(
                f"Refusing to exec: code length {len(code)} exceeds "
                f"{MAX_CODE_CHARS} chars cap."
            ),
        )

    try:
        proc = sb.exec("python", "-c", code, timeout=_EXEC_TIMEOUT_S)
        # `.wait()` isn't strictly needed before `.read()` because the
        # PIPE readers block until EOF, but calling it ensures we get a
        # definite exit code even if stdout/stderr are empty.
        stdout = proc.stdout.read()
        stderr = proc.stderr.read()
        proc.wait()
        return ExecResult(
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=stdout or "",
            stderr=stderr or "",
        )
    except Exception as e:
        chat_log("warn", "research_sandbox_exec_error", err=repr(e))
        return ExecResult(
            exit_code=1,
            stdout="",
            stderr=f"Sandbox exec raised {type(e).__name__}: {e}",
        )


def teardown_sandbox(sb: modal.Sandbox | None) -> None:
    """Best-effort terminate + detach. Never raises.

    `terminate()` stops billing; `detach()` closes the local gRPC
    connection. We want both regardless of whether the research loop
    succeeded or errored — a leaked sandbox is an expensive bug.
    """
    if sb is None:
        return
    try:
        sb.terminate()
    except Exception as e:
        chat_log("warn", "research_sandbox_terminate_failed", err=repr(e))
    try:
        sb.detach()
    except Exception as e:
        chat_log("warn", "research_sandbox_detach_failed", err=repr(e))


def env_key_int(name: str, fallback: int) -> int:
    """Small helper mirroring the TS envInt used in codebase_agent."""
    v = os.environ.get(name)
    if not v:
        return fallback
    try:
        n = int(v)
        return n if n > 0 else fallback
    except ValueError:
        return fallback
