"""
Deploy from the repo root: `modal deploy runner/modal_app.py`
(Running `modal deploy` inside `runner/` breaks `add_local_python_source("runner")`.)
"""
import modal

app = modal.App("atlas-runner")

runner_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "stagehand",
        "supabase",
        "anthropic",
        "agentmail",
        "httpx",
        "pydantic",
        "browserbase",
    )
    .add_local_python_source("runner")
)


@app.function(
    image=runner_image,
    secrets=[modal.Secret.from_name("atlas-secrets")],
    timeout=1800,  # 30 minutes max per test run
)
async def execute_test_run(test_run_id: str, project_id: str):
    """Main entry point triggered from Next.js via Modal TypeScript SDK."""
    from runner.execute import run_test_pipeline
    await run_test_pipeline(test_run_id, project_id)
