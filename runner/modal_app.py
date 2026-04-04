"""
Deploy from repo root: `modal deploy runner/modal_app.py`
(Not from `runner/` — add_local_python_source("runner") expects a sibling `runner/` dir.)
"""
import modal

app = modal.App("atlas-runner")

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
    timeout=1800,  # 30 minutes max per test run
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
