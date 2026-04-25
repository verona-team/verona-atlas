"""Verona Modal app: test execution + chat turn orchestration.

Deploy from repo root: `modal deploy runner/modal_app.py`
(Not from `runner/` — add_local_python_source("runner") expects a sibling
`runner/` dir.)

Two concerns live here:

1. `execute_test_run` — runs QA test flows in cloud browsers. Long-running,
   heavy runtime (Playwright, Stagehand, Browserbase).

2. `process_chat_turn` / `process_nightly_job` — chat orchestration. Durable
   replacement for the old Next.js `/api/chat` path so chat turns survive
   hard refresh / tab close. Runs a LangGraph StateGraph against Gemini
   3.1 Pro (with Gemini 3 Flash for summarization subtasks).

They share a secret ("atlas-secrets") but intentionally use separate images
so the chat path doesn't pay for the Playwright / browser toolchain cold
start, and vice versa.

## Logging

Every Modal entry point emits a single JSON-per-line log stream via
`runner.logging`. The entry points themselves use bound loggers with
`test_run_id` / `session_id` / `project_id` / `turn_id` context so
every downstream line can be filtered to a single invocation.
"""
import modal

app = modal.App("atlas-runner")

# -----------------------------------------------------------------------------
# Image 1: test runner (existing)
# -----------------------------------------------------------------------------
runner_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "stagehand>=3.19,<4",
        "supabase",
        # `anthropic` is still required by the Stagehand session/agent path —
        # Stagehand forwards API calls through its own client configured with
        # ANTHROPIC_API_KEY. The outer QA ReAct loop ALSO talks to Anthropic
        # (Claude Opus 4.7) via `langchain-anthropic`; see below.
        "anthropic",
        "agentmail>=0.4",
        "httpx",
        "pydantic",
        "browserbase",
        "playwright",
        # The outer ReAct loop model is Claude Opus 4.7 via
        # `langchain-anthropic` (instantiated through
        # `runner.chat.models.get_claude_opus_outer`). The reporter summary
        # model still goes through `langchain-google-genai` (Gemini 3 Flash),
        # and the research code-writer path uses `get_claude_opus_code_writer`
        # which is also `langchain-anthropic`-backed. All three integrations
        # need to be present in this image — historically only the Gemini
        # bindings were installed, which caused every template to fail with
        # `ModuleNotFoundError: No module named 'langchain_anthropic'` the
        # moment the outer model was constructed.
        "langchain>=1.0.0,<2.0.0",
        "langchain-core>=1.0.0,<2.0.0",
        "langchain-google-genai>=3.1.0,<4.0.0",
        "langchain-anthropic>=1.1.0,<2.0.0",
        "google-genai>=1.0.0,<2.0.0",
    )
    .run_commands("playwright install --with-deps chromium")
    .add_local_python_source("runner")
)


@app.function(
    image=runner_image,
    secrets=[modal.Secret.from_name("atlas-secrets")],
    timeout=86400,  # 24h hard ceiling; actual deadline is enforced dynamically inside the pipeline
)
async def execute_test_run(test_run_id: str, project_id: str):
    """Main entry point triggered from Next.js via Modal TypeScript SDK.

    We bind `test_run_id` + `project_id` to the logger once here so every
    downstream log line in the pipeline inherits them — this is what
    makes it possible to filter a full run to one coherent log stream.
    """
    import time

    from runner.logging import bind

    log = bind(
        "modal_test_runner",
        test_run_id=test_run_id,
        project_id=project_id,
    )

    t0 = time.time()
    log.info(
        "execute_test_run_invoked",
        modal_function="execute_test_run",
    )

    try:
        from runner.execute import run_test_pipeline

        await run_test_pipeline(test_run_id, project_id)
        log.info(
            "execute_test_run_ok",
            elapsed_s=round(time.time() - t0, 3),
        )
    except Exception as e:
        import traceback as _tb

        log.error(
            "execute_test_run_failed",
            elapsed_s=round(time.time() - t0, 3),
            err_type=type(e).__name__,
            err=str(e),
            traceback=_tb.format_exc(),
        )
        raise


# -----------------------------------------------------------------------------
# Image 2: chat runner (LangGraph + LangChain + Google Gemini)
# -----------------------------------------------------------------------------
# Separate image because:
#   * The chat workload doesn't need Playwright/Chromium/Stagehand.
#   * Cold starts stay lean (<10s vs ~45s for the browser image).
#   * LangGraph/LangChain versions can be bumped without affecting the
#     browser runner.
#
# Version pinning: we pin the LangChain family to a known-good minor range
# so upgrades are a conscious decision. langgraph 1.0.x, langchain 1.0.x,
# langchain-google-genai 3.1.x all compose cleanly as of this writing.
# `langchain-anthropic` is still included because `runner.chat.models`
# exposes a `get_claude_opus()` helper for Anthropic-backed paths (the
# Stagehand browser agent lives in the runner_image, but `get_claude_opus`
# may be reached from chat-side helpers during future work).
chat_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "langgraph>=1.0.0,<2.0.0",
        "langchain>=1.0.0,<2.0.0",
        "langchain-core>=1.0.0,<2.0.0",
        "langchain-google-genai>=3.1.0,<4.0.0",
        "google-genai>=1.0.0,<2.0.0",
        "langchain-anthropic>=1.1.0,<2.0.0",
        "langsmith>=0.4.0",
        "anthropic>=0.76.0",
        "supabase>=2.21.0",
        "httpx>=0.28.0,<1.0.0",
        "pydantic>=2.12.0,<3.0.0",
        "pyjwt>=2.10.0",
        "cryptography>=46.0.0",
        "modal>=1.4.0,<2.0.0",  # nested spawn of execute_test_run from inside chat tool
    )
    .add_local_python_source("runner")
)


@app.function(
    image=chat_image,
    secrets=[modal.Secret.from_name("atlas-secrets")],
    # 1h cap — typical turn is <3min, but the research agent's first run on
    # a cold project can take several minutes. This cap protects against
    # infinite-loop scenarios without forcing us to tune each node.
    timeout=3600,
    # We manage retry semantics ourselves via DB idempotency keys (client_message_id
    # + active_chat_call_id). Modal-level retries would re-run side effects.
    retries=0,
)
async def process_chat_turn(
    session_id: str,
    project_id: str,
    user_message_client_id: str,
    user_message_text: str,
) -> None:
    """Run one full chat turn: research (if needed) -> agent -> tools -> persist.

    Invoked via `fn.spawn()` from the Next.js /api/chat route so the caller
    returns 202 immediately. All user-visible side effects land in Supabase
    and surface on the client via Supabase Realtime; this function never
    communicates directly with the browser.

    The current turn's `user_message_text` is passed as a function argument
    rather than re-read from `chat_messages`. The Next.js route already has
    the text in hand (it just wrote it to the DB); shipping it over as an
    argument removes an entire class of read-your-writes bugs where the
    Python replica hadn't yet seen the row the route just committed.
    `user_message_client_id` is still passed through for idempotency +
    trace correlation and for the historical-messages load (we skip a row
    in history if it matches this id, so we don't include the current
    turn twice when the DB row IS visible).
    """
    import time
    import traceback

    from runner.logging import chat_log

    t0 = time.time()
    chat_log(
        "info",
        "process_chat_turn_invoked",
        project_id=project_id,
        session_id=session_id,
        user_message_client_id=user_message_client_id,
        user_message_text_len=len(user_message_text or ""),
        modal_function="process_chat_turn",
    )
    try:
        from runner.chat.turn import run_chat_turn

        await run_chat_turn(
            session_id,
            project_id,
            user_message_client_id,
            user_message_text,
        )
        chat_log(
            "info",
            "process_chat_turn_ok",
            project_id=project_id,
            session_id=session_id,
            elapsed_s=round(time.time() - t0, 3),
        )
    except Exception as e:
        chat_log(
            "error",
            "process_chat_turn_failed",
            project_id=project_id,
            session_id=session_id,
            elapsed_s=round(time.time() - t0, 3),
            err_type=type(e).__name__,
            err=str(e),
            traceback=traceback.format_exc(),
        )
        raise


@app.function(
    image=chat_image,
    secrets=[modal.Secret.from_name("atlas-secrets")],
    timeout=3600,
    retries=0,
)
async def process_nightly_job(project_id: str) -> None:
    """Scheduled-research equivalent of process_chat_turn for the nightly cron.

    Runs the same research + flow-proposal pipeline that process_chat_turn
    does during bootstrap, minus the conversational LLM: nightly is always
    a synthetic bootstrap ("here's what changed overnight"). Optionally
    notifies Slack on completion.
    """
    import time
    import traceback

    from runner.logging import chat_log

    t0 = time.time()
    chat_log(
        "info",
        "process_nightly_job_invoked",
        project_id=project_id,
        modal_function="process_nightly_job",
    )
    try:
        from runner.chat.nightly import run_nightly_job

        await run_nightly_job(project_id)
        chat_log(
            "info",
            "process_nightly_job_ok",
            project_id=project_id,
            elapsed_s=round(time.time() - t0, 3),
        )
    except Exception as e:
        chat_log(
            "error",
            "process_nightly_job_failed",
            project_id=project_id,
            elapsed_s=round(time.time() - t0, 3),
            err_type=type(e).__name__,
            err=str(e),
            traceback=traceback.format_exc(),
        )
        raise
