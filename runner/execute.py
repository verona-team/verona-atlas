"""
Atlas Test Runner — Main Orchestrator
Loads project → executes templates (DB order) → reports results
"""
import json
import os
import asyncio
import traceback
from datetime import datetime, timezone

from supabase import create_client as create_supabase_client

from runner.test_executor import execute_template
from runner.auth import authenticate
from runner.reporter import send_report
from runner.encryption import decrypt
from runner.observability import collect_observability_data, diff_observability_snapshots
from runner.recordings import save_session_recording


def _template_ids_from_trigger_ref(trigger_ref: str | None) -> list[str] | None:
    """If set, the run should only execute these template rows (e.g. chat-approved flows)."""
    if not trigger_ref or not str(trigger_ref).strip():
        return None
    try:
        obj = json.loads(trigger_ref)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    raw = obj.get("template_ids")
    if not isinstance(raw, list):
        return None
    ids = [str(x) for x in raw if x]
    return ids or None


async def run_test_pipeline(test_run_id: str, project_id: str):
    """Full test execution pipeline."""
    supabase_url = os.environ["SUPABASE_URL"]
    supabase_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    supabase = create_supabase_client(supabase_url, supabase_key)
    
    try:
        # 1. Load project
        project = supabase.table("projects").select("*").eq("id", project_id).single().execute().data
        if not project:
            raise ValueError(f"Project {project_id} not found")

        # 2. Load test run (scope: which templates this invocation should execute)
        run_row = supabase.table("test_runs").select("trigger_ref").eq("id", test_run_id).single().execute().data
        if not run_row:
            raise ValueError(f"Test run {test_run_id} not found")

        scoped_template_ids = _template_ids_from_trigger_ref(run_row.get("trigger_ref"))

        # 3. Load integrations
        integrations_resp = supabase.table("integrations").select("*").eq("project_id", project_id).execute()
        integrations = {i["type"]: i for i in (integrations_resp.data or [])}

        # 4. Update status to planning
        supabase.table("test_runs").update({
            "status": "planning",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", test_run_id).execute()

        # 5. Load active templates (full project, or only IDs recorded on this run for chat flows)
        q = supabase.table("test_templates").select("*").eq("project_id", project_id).eq("is_active", True)
        if scoped_template_ids is not None:
            q = q.in_("id", scoped_template_ids)
        templates_resp = q.execute()
        templates = templates_resp.data or []

        if not templates:
            msg = (
                "No active test templates found for this run"
                if scoped_template_ids is not None
                else "No active test templates found"
            )
            supabase.table("test_runs").update({
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "summary": {"message": msg, "total": 0, "passed": 0, "failed": 0},
            }).eq("id", test_run_id).execute()
            return

        # 6. Update status to running
        supabase.table("test_runs").update({"status": "running"}).eq("id", test_run_id).execute()

        # 7. Execute each template (order from DB query)
        results = []
        for template in templates:
            start_time = datetime.now(timezone.utc)
            try:
                result = await execute_single_template(supabase, project, template, test_run_id, integrations)
                results.append(result)
            except Exception as e:
                duration_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
                error_result = {
                    "test_run_id": test_run_id,
                    "test_template_id": template["id"],
                    "status": "error",
                    "duration_ms": duration_ms,
                    "error_message": str(e),
                    "screenshots": [],
                    "console_logs": {"error": traceback.format_exc()},
                }
                supabase.table("test_results").insert(error_result).execute()
                results.append(error_result)

        # 8. Aggregate results
        passed = sum(1 for r in results if r.get("status") == "passed")
        failed = sum(1 for r in results if r.get("status") == "failed")
        errors = sum(1 for r in results if r.get("status") == "error")
        skipped = sum(1 for r in results if r.get("status") == "skipped")

        summary = {
            "total": len(results),
            "passed": passed,
            "failed": failed,
            "errors": errors,
            "skipped": skipped,
        }

        # 9. Update test run as completed
        supabase.table("test_runs").update({
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": summary,
        }).eq("id", test_run_id).execute()

        # 10. Send Slack report
        await send_report(supabase, project, integrations, test_run_id, results, summary)

    except Exception as e:
        # Mark run as failed
        supabase.table("test_runs").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": {"error": str(e), "traceback": traceback.format_exc()},
        }).eq("id", test_run_id).execute()
        raise


async def upload_screenshots(supabase, screenshots: list[dict], test_run_id: str, template_name: str) -> list[str]:
    """Upload screenshot PNGs to Supabase Storage and return public URLs."""
    import base64

    urls: list[str] = []
    supabase_url = os.environ.get("SUPABASE_URL", "")
    safe_name = template_name.replace(" ", "_").replace("/", "_")[:50]

    for i, shot in enumerate(screenshots):
        raw_b64 = shot.get("base64", "")
        if not raw_b64:
            continue

        try:
            image_bytes = base64.b64decode(raw_b64)
            label = shot.get("label", f"step_{i}")[:60]
            file_path = f"{test_run_id}/{safe_name}_{label}.png"

            supabase.storage.from_("test-screenshots").upload(
                path=file_path,
                file=image_bytes,
                file_options={"content-type": "image/png"},
            )
            public_url = f"{supabase_url}/storage/v1/object/public/test-screenshots/{file_path}"
            urls.append(public_url)
        except Exception as e:
            print(f"Warning: failed to upload screenshot {i}: {e}")

    return urls


async def execute_single_template(supabase, project, template, test_run_id: str, integrations: dict | None = None) -> dict:
    """Execute a single test template in an isolated browser session."""
    from stagehand import Stagehand
    
    start_time = datetime.now(timezone.utc)
    integrations = integrations or {}
    browserbase_session_id: str | None = None

    pre_snapshot: dict = {}
    try:
        pre_snapshot = await collect_observability_data(integrations, window_minutes=1)
    except Exception as e:
        print(f"Warning: pre-test observability snapshot failed: {e}")
    
    stagehand = Stagehand(env="BROWSERBASE")
    try:
        await stagehand.init()

        if hasattr(stagehand, 'browserbase_session_id'):
            browserbase_session_id = stagehand.browserbase_session_id
        elif hasattr(stagehand, 'session_id'):
            browserbase_session_id = stagehand.session_id
        
        if project.get("auth_email") and project.get("auth_password_encrypted"):
            password = decrypt(project["auth_password_encrypted"])
            await authenticate(stagehand, project, password)
        
        agent_result = await execute_template(stagehand, template, project, integrations)
        
        test_passed = agent_result.get("passed", False)
        status = "passed" if test_passed else "failed"
        error_message = None if test_passed else agent_result.get("summary", "Test failed")

        bugs = agent_result.get("bugs_found", [])
        if bugs and status == "passed":
            status = "failed"
            error_message = "; ".join(b.get("description", "") for b in bugs)

        duration_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)

        observability_errors: dict = {}
        try:
            await asyncio.sleep(3)
            post_snapshot = await collect_observability_data(integrations, window_minutes=2)
            observability_errors = diff_observability_snapshots(pre_snapshot, post_snapshot)
        except Exception as e:
            print(f"Warning: post-test observability snapshot failed: {e}")

        if observability_errors and status == "passed":
            status = "failed"
            error_sources = [k for k, v in observability_errors.items() if v]
            error_message = f"Observability errors detected in: {', '.join(error_sources)}"

        screenshot_urls: list[str] = []
        raw_screenshots = agent_result.get("screenshots", [])
        if raw_screenshots:
            try:
                screenshot_urls = await upload_screenshots(
                    supabase, raw_screenshots, test_run_id,
                    template.get("name", "unknown"),
                )
            except Exception as e:
                print(f"Warning: screenshot upload failed: {e}")

        recording_url = None
        if browserbase_session_id:
            try:
                recording_url = await save_session_recording(
                    supabase,
                    browserbase_session_id,
                    test_run_id,
                    template.get("name", "unknown"),
                )
            except Exception as e:
                print(f"Warning: Failed to save recording: {e}")

        actions_for_log = []
        for a in agent_result.get("actions", []):
            entry = {k: v for k, v in a.items() if k != "screenshot_base64"}
            actions_for_log.append(entry)

        result = {
            "test_run_id": test_run_id,
            "test_template_id": template["id"],
            "status": status,
            "duration_ms": duration_ms,
            "error_message": error_message,
            "screenshots": screenshot_urls,
            "recording_url": recording_url,
            "console_logs": {
                "agent_summary": agent_result.get("summary", ""),
                "bugs_found": bugs,
                "actions": actions_for_log,
                "iterations_used": agent_result.get("iterations_used", 0),
                "max_iterations": agent_result.get("max_iterations", 0),
                "hit_iteration_limit": agent_result.get("hit_iteration_limit", False),
                "observability": observability_errors,
            },
        }
        
        supabase.table("test_results").insert(result).execute()
        return result
        
    finally:
        try:
            await stagehand.close()
        except Exception:
            pass
