"""
Atlas Test Runner — Main Orchestrator
Loads project → executes templates (DB order) → reports results
"""
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

        # 2. Load integrations
        integrations_resp = supabase.table("integrations").select("*").eq("project_id", project_id).execute()
        integrations = {i["type"]: i for i in (integrations_resp.data or [])}

        # 3. Update status to planning
        supabase.table("test_runs").update({
            "status": "planning",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", test_run_id).execute()

        # 4. Load active templates
        templates_resp = supabase.table("test_templates").select("*").eq("project_id", project_id).eq("is_active", True).execute()
        templates = templates_resp.data or []

        if not templates:
            supabase.table("test_runs").update({
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "summary": {"message": "No active test templates found", "total": 0, "passed": 0, "failed": 0},
            }).eq("id", test_run_id).execute()
            return

        # 5. Update status to running
        supabase.table("test_runs").update({"status": "running"}).eq("id", test_run_id).execute()

        # 6. Execute each template (order from DB query)
        results = []
        for template in templates:
            start_time = datetime.now(timezone.utc)
            try:
                result = await execute_single_template(supabase, project, template, test_run_id, integrations)
                results.append(result)
            except Exception as e:
                # Record failed result
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

        # 7. Aggregate results
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

        # 8. Update test run as completed
        supabase.table("test_runs").update({
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": summary,
        }).eq("id", test_run_id).execute()

        # 9. Send Slack report
        await send_report(supabase, project, integrations, test_run_id, results, summary)

    except Exception as e:
        # Mark run as failed
        supabase.table("test_runs").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": {"error": str(e), "traceback": traceback.format_exc()},
        }).eq("id", test_run_id).execute()
        raise


async def execute_single_template(supabase, project, template, test_run_id: str, integrations: dict | None = None) -> dict:
    """Execute a single test template in an isolated browser session."""
    from stagehand import Stagehand
    
    start_time = datetime.now(timezone.utc)
    screenshots = []
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
        
        step_results = await execute_template(stagehand, template, project)
        
        all_passed = all(s.get("passed", False) for s in step_results)
        status = "passed" if all_passed else "failed"
        error_message = None
        if not all_passed:
            failed_steps = [s for s in step_results if not s.get("passed", False)]
            error_message = "; ".join(s.get("error", "Unknown error") for s in failed_steps)
        
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
        
        result = {
            "test_run_id": test_run_id,
            "test_template_id": template["id"],
            "status": status,
            "duration_ms": duration_ms,
            "error_message": error_message,
            "screenshots": screenshots,
            "recording_url": recording_url,
            "console_logs": {
                "steps": step_results,
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
