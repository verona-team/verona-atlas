"""Verona Modal app: test execution + chat turn orchestration.

Deploy from repo root: `modal deploy runner/modal_app.py`
(Not from `runner/` — add_local_python_source("runner") expects a sibling
`runner/` dir.)

Two concerns live here:

1. `execute_test_run` — runs QA test flows in cloud browsers. Long-running,
   heavy runtime (Playwright, Stagehand, Browserbase).

2. `process_chat_turn` / `process_nightly_job` — chat orchestration. Durable
   replacement for the old Next.js `/api/chat` path so chat turns survive
   hard refresh / tab close. Runs a LangGraph StateGraph against Claude.

They share a secret ("atlas-secrets") but intentionally use separate images
so the chat path doesn't pay for the Playwright / browser toolchain cold
start, and vice versa.
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
        "anthropic",
        "agentmail>=0.4",
        "httpx",
        "pydantic",
        "browserbase",
        "playwright",
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
    """Main entry point triggered from Next.js via Modal TypeScript SDK."""
    import time
    import traceback

    t0 = time.time()
    print("=" * 72)
    print(f"[MODAL] execute_test_run invoked")
    print(f"[MODAL]   test_run_id = {test_run_id}")
    print(f"[MODAL]   project_id  = {project_id}")
    print("=" * 72)

    try:
        from runner.execute import run_test_pipeline
        await run_test_pipeline(test_run_id, project_id)
        elapsed = time.time() - t0
        print("=" * 72)
        print(f"[MODAL] execute_test_run completed successfully in {elapsed:.1f}s")
        print("=" * 72)
    except Exception as e:
        elapsed = time.time() - t0
        print("=" * 72)
        print(f"[MODAL] execute_test_run FAILED after {elapsed:.1f}s")
        print(f"[MODAL]   error: {type(e).__name__}: {e}")
        print(f"[MODAL]   traceback:\n{traceback.format_exc()}")
        print("=" * 72)
        raise


# -----------------------------------------------------------------------------
# Image 2: chat runner (LangGraph + LangChain + Anthropic)
# -----------------------------------------------------------------------------
# Separate image because:
#   * The chat workload doesn't need Playwright/Chromium/Stagehand.
#   * Cold starts stay lean (<10s vs ~45s for the browser image).
#   * LangGraph/LangChain versions can be bumped without affecting the
#     browser runner.
#
# Version pinning: we pin the LangChain family to a known-good minor range
# so upgrades are a conscious decision. langgraph 1.0.x, langchain 1.0.x,
# langchain-anthropic 1.1.x all compose cleanly as of this writing.
chat_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "langgraph>=1.0.0,<2.0.0",
        "langchain>=1.0.0,<2.0.0",
        "langchain-core>=1.0.0,<2.0.0",
        "langchain-anthropic>=1.1.0,<2.0.0",
        "langsmith>=0.4.0",
        "anthropic>=0.76.0",
        "supabase>=2.21.0",
        "httpx>=0.28.0,<1.0.0",
        "pydantic>=2.12.0,<3.0.0",
        "pyjwt>=2.10.0",
        "cryptography>=46.0.0",
        "modal>=1.5.0",  # nested spawn of execute_test_run from inside chat tool
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
) -> None:
    """Run one full chat turn: research (if needed) -> agent -> tools -> persist.

    Invoked via `fn.spawn()` from the Next.js /api/chat route so the caller
    returns 202 immediately. All user-visible side effects land in Supabase
    and surface on the client via Supabase Realtime; this function never
    communicates directly with the browser.
    """
    import time
    import traceback

    t0 = time.time()
    print(
        f"[MODAL_CHAT] process_chat_turn invoked "
        f"session={session_id} project={project_id} "
        f"client_msg_id={user_message_client_id}"
    )
    try:
        from runner.chat.turn import run_chat_turn

        await run_chat_turn(session_id, project_id, user_message_client_id)
        print(
            f"[MODAL_CHAT] process_chat_turn OK in {time.time() - t0:.1f}s "
            f"session={session_id}"
        )
    except Exception as e:
        print(
            f"[MODAL_CHAT] process_chat_turn FAILED in {time.time() - t0:.1f}s "
            f"session={session_id} err={type(e).__name__}: {e}"
        )
        print(traceback.format_exc())
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

    t0 = time.time()
    print(f"[MODAL_CHAT] process_nightly_job invoked project={project_id}")
    try:
        from runner.chat.nightly import run_nightly_job

        await run_nightly_job(project_id)
        print(
            f"[MODAL_CHAT] process_nightly_job OK in {time.time() - t0:.1f}s "
            f"project={project_id}"
        )
    except Exception as e:
        print(
            f"[MODAL_CHAT] process_nightly_job FAILED in {time.time() - t0:.1f}s "
            f"project={project_id} err={type(e).__name__}: {e}"
        )
        print(traceback.format_exc())
        raise
