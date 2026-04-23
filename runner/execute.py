"""
Atlas Test Runner — Main Orchestrator
Loads project → executes templates (DB order) → reports results

All log lines emitted from this module are single-line JSON with
`source: "modal_test_runner"` and a bound `test_run_id` / `project_id`
context. See `runner.logging` for the wire shape.
"""
import json
import os
import asyncio
import secrets
import string
import time
import traceback
from datetime import datetime, timezone

from supabase import create_client as create_supabase_client

from runner.test_executor import execute_template
from runner.reporter import send_report
from runner.encryption import decrypt, encrypt
from runner.logging import bind, test_log
from runner.observability import collect_observability_data, diff_observability_snapshots
from runner.recordings import save_session_recording
from runner.browser import create_stagehand_session, cleanup_session

SECONDS_PER_TEMPLATE = 3600  # 1 hour budget per template


def _load_chat_session_id(supabase, project_id: str) -> str | None:
    """Return the chat session id for this project, if one exists."""
    try:
        resp = (
            supabase.table("chat_sessions")
            .select("id")
            .eq("project_id", project_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if rows:
            return rows[0]["id"]
    except Exception as e:
        test_log(
            "warn",
            "pipeline_chat_session_lookup_failed",
            project_id=project_id,
            err_type=type(e).__name__,
            err=str(e),
        )
    return None


def _insert_live_session_chat_message(
    supabase,
    *,
    chat_session_id: str,
    test_run_id: str,
    test_template_id: str,
    template_name: str,
    browserbase_session_id: str,
    live_view_url: str | None,
    live_view_fullscreen_url: str | None,
    live_view_debugger_url: str | None,
) -> str | None:
    """Insert a chat message advertising a live browser session for a test.

    Returns the message id so it can be updated when the test finishes.
    """
    metadata = {
        "type": "live_session",
        "status": "running",
        "run_id": test_run_id,
        "test_template_id": test_template_id,
        "template_name": template_name,
        "browserbase_session_id": browserbase_session_id,
        "live_view_url": live_view_url,
        "live_view_fullscreen_url": live_view_fullscreen_url,
        "live_view_debugger_url": live_view_debugger_url,
        "browserbase_dashboard_url": f"https://www.browserbase.com/sessions/{browserbase_session_id}",
    }
    try:
        resp = (
            supabase.table("chat_messages")
            .insert({
                "session_id": chat_session_id,
                "role": "assistant",
                "content": f"Running test: {template_name}",
                "metadata": metadata,
            })
            .select("id")
            .single()
            .execute()
        )
        row = resp.data or {}
        msg_id = row.get("id")
        test_log(
            "info",
            "pipeline_live_session_chat_message_inserted",
            test_run_id=test_run_id,
            template_id=test_template_id,
            template_name=template_name,
            chat_message_id=msg_id,
            browserbase_session_id=browserbase_session_id,
        )
        return msg_id
    except Exception as e:
        test_log(
            "warn",
            "pipeline_live_session_chat_message_insert_failed",
            test_run_id=test_run_id,
            template_id=test_template_id,
            err_type=type(e).__name__,
            err=str(e),
        )
        return None


def _update_live_session_chat_message(
    supabase,
    chat_message_id: str,
    *,
    status: str,
    recording_url: str | None,
    error_message: str | None,
    duration_ms: int | None,
) -> None:
    """Finalize the live-session chat bubble once the template finishes.

    Rewrites ``metadata`` so the UI flips from the embedded live iframe
    to a completed state with the saved recording link.
    """
    try:
        existing = (
            supabase.table("chat_messages")
            .select("content, metadata")
            .eq("id", chat_message_id)
            .single()
            .execute()
            .data
        )
        current_meta = (existing or {}).get("metadata") or {}
        template_name = current_meta.get("template_name", "test")

        new_meta = {
            **current_meta,
            "status": status,
            "recording_url": recording_url,
            "error_message": error_message,
            "duration_ms": duration_ms,
        }

        verb = "Finished" if status == "passed" else ("Failed" if status == "failed" else "Ended")
        new_content = f"{verb} test: {template_name}"

        supabase.table("chat_messages").update({
            "content": new_content,
            "metadata": new_meta,
        }).eq("id", chat_message_id).execute()
        test_log(
            "info",
            "pipeline_live_session_chat_message_updated",
            chat_message_id=chat_message_id,
            status=status,
            duration_ms=duration_ms,
        )
    except Exception as e:
        test_log(
            "warn",
            "pipeline_live_session_chat_message_update_failed",
            chat_message_id=chat_message_id,
            err_type=type(e).__name__,
            err=str(e),
        )


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


def _generate_password(length: int = 24) -> str:
    """Generate a strong random password for agent signup."""
    alphabet = string.ascii_letters + string.digits + "!@#$%&*"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        has_upper = any(c.isupper() for c in pw)
        has_lower = any(c.islower() for c in pw)
        has_digit = any(c.isdigit() for c in pw)
        has_special = any(c in "!@#$%&*" for c in pw)
        if has_upper and has_lower and has_digit and has_special:
            return pw


def _load_agent_credentials(supabase, project_id: str) -> dict | None:
    """Load active agent credentials for a project, if any exist."""
    resp = (
        supabase.table("agent_credentials")
        .select("*")
        .eq("project_id", project_id)
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return None
    row = rows[0]
    try:
        password = decrypt(row["password_encrypted"])
    except Exception as e:
        test_log(
            "warn",
            "pipeline_agent_credentials_decrypt_failed",
            project_id=project_id,
            err_type=type(e).__name__,
            err=str(e),
        )
        return None
    return {
        "id": row["id"],
        "email": row["email"],
        "password": password,
    }


async def _save_agent_credentials(supabase, project_id: str, email: str, password: str) -> None:
    """Upsert agent credentials for a project (encrypt password at rest)."""
    encrypted = encrypt(password)
    now = datetime.now(timezone.utc).isoformat()

    existing = (
        supabase.table("agent_credentials")
        .select("id")
        .eq("project_id", project_id)
        .limit(1)
        .execute()
    )
    if existing.data:
        supabase.table("agent_credentials").update({
            "email": email,
            "password_encrypted": encrypted,
            "status": "active",
            "updated_at": now,
            "last_used_at": now,
        }).eq("id", existing.data[0]["id"]).execute()
        test_log(
            "info",
            "pipeline_agent_credentials_updated",
            project_id=project_id,
            email=email,
        )
    else:
        supabase.table("agent_credentials").insert({
            "project_id": project_id,
            "email": email,
            "password_encrypted": encrypted,
            "status": "active",
            "last_used_at": now,
        }).execute()
        test_log(
            "info",
            "pipeline_agent_credentials_inserted",
            project_id=project_id,
            email=email,
        )


async def run_test_pipeline(test_run_id: str, project_id: str):
    """Full test execution pipeline."""
    log = bind(
        "modal_test_runner",
        test_run_id=test_run_id,
        project_id=project_id,
    )
    pipeline_t0 = time.time()
    log.info("pipeline_start")

    supabase_url = os.environ["SUPABASE_URL"]
    supabase_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    supabase = create_supabase_client(supabase_url, supabase_key)
    log.debug("pipeline_supabase_client_ready")

    try:
        # 1. Load project
        log.info("pipeline_load_project_begin")
        project = supabase.table("projects").select("*").eq("id", project_id).single().execute().data
        if not project:
            raise ValueError(f"Project {project_id} not found")
        log.info(
            "pipeline_load_project_ok",
            project_name=project.get("name"),
            app_url=project.get("app_url"),
            agentmail_inbox_address=project.get("agentmail_inbox_address"),
        )

        # 2. Load test run
        log.info("pipeline_load_test_run_begin")
        run_row = (
            supabase.table("test_runs")
            .select("trigger_ref, trigger")
            .eq("id", test_run_id)
            .single()
            .execute()
            .data
        )
        if not run_row:
            raise ValueError(f"Test run {test_run_id} not found")

        scoped_template_ids = _template_ids_from_trigger_ref(run_row.get("trigger_ref"))
        log.info(
            "pipeline_load_test_run_ok",
            trigger=run_row.get("trigger"),
            trigger_ref=run_row.get("trigger_ref"),
            scoped_template_count=(
                len(scoped_template_ids) if scoped_template_ids is not None else None
            ),
        )

        # Only post chat-message live views when the run originated from chat.
        chat_session_id: str | None = None
        if run_row.get("trigger") == "chat":
            chat_session_id = _load_chat_session_id(supabase, project_id)
            log.info(
                "pipeline_chat_session_resolved",
                chat_session_id=chat_session_id,
            )

        # 3. Load integrations
        log.info("pipeline_load_integrations_begin")
        integrations_resp = supabase.table("integrations").select("*").eq("project_id", project_id).execute()
        integrations = {i["type"]: i for i in (integrations_resp.data or [])}
        log.info(
            "pipeline_load_integrations_ok",
            integrations=list(integrations.keys()),
        )

        # 3b. Load agent credentials (if any from previous runs)
        log.info("pipeline_load_agent_credentials_begin")
        agent_creds = _load_agent_credentials(supabase, project_id)
        log.info(
            "pipeline_load_agent_credentials_ok",
            has_credentials=agent_creds is not None,
            email=agent_creds["email"] if agent_creds else None,
        )

        agentmail_address = project.get("agentmail_inbox_address")
        agentmail_inbox_id = project.get("agentmail_inbox_id")
        # Always generate a password — even when credentials exist, the agent
        # may need to create a new account if the saved credentials fail.
        generated_password = _generate_password()
        log.debug(
            "pipeline_generated_signup_password",
            password_length=len(generated_password),
        )

        # 4. Update status to planning
        log.info("pipeline_status_update", new_status="planning")
        supabase.table("test_runs").update({
            "status": "planning",
            "started_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", test_run_id).execute()

        # 5. Load active templates
        log.info("pipeline_load_templates_begin")
        q = supabase.table("test_templates").select("*").eq("project_id", project_id).eq("is_active", True)
        if scoped_template_ids is not None:
            q = q.in_("id", scoped_template_ids)
        templates_resp = q.execute()
        templates = templates_resp.data or []
        log.info(
            "pipeline_load_templates_ok",
            template_count=len(templates),
            templates=[
                {
                    "id": t["id"],
                    "name": t.get("name"),
                    "step_count": len(t.get("steps") or []),
                }
                for t in templates
            ],
        )

        if not templates:
            msg = (
                "No active test templates found for this run"
                if scoped_template_ids is not None
                else "No active test templates found"
            )
            log.warn("pipeline_no_templates_found", message=msg)
            supabase.table("test_runs").update({
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "summary": {"message": msg, "total": 0, "passed": 0, "failed": 0},
            }).eq("id", test_run_id).execute()
            return

        # Compute dynamic deadline: 1 hour per template
        total_timeout = len(templates) * SECONDS_PER_TEMPLATE
        deadline = pipeline_t0 + total_timeout
        log.info(
            "pipeline_deadline_computed",
            total_timeout_s=total_timeout,
            seconds_per_template=SECONDS_PER_TEMPLATE,
            template_count=len(templates),
        )

        # 6. Update status to running
        log.info("pipeline_status_update", new_status="running")
        supabase.table("test_runs").update({"status": "running"}).eq("id", test_run_id).execute()

        # 7. Execute each template
        results = []
        for idx, template in enumerate(templates):
            tpl_name = template.get("name", "unnamed")
            tpl_id = template["id"]
            tpl_log = log.bind(template_id=tpl_id, template_name=tpl_name, template_index=idx)

            remaining = deadline - time.time()
            if remaining <= 0:
                tpl_log.warn(
                    "pipeline_template_skipped_deadline",
                    remaining_s=round(remaining, 3),
                    skip_count=len(templates) - idx,
                )
                for skip_tpl in templates[idx:]:
                    results.append({
                        "test_run_id": test_run_id,
                        "test_template_id": skip_tpl["id"],
                        "status": "skipped",
                        "duration_ms": 0,
                        "error_message": f"Skipped — pipeline deadline of {total_timeout}s exceeded",
                        "screenshots": [],
                        "console_logs": {"skipped_reason": "timeout"},
                    })
                    supabase.table("test_results").insert(results[-1]).execute()
                break

            tpl_log.info(
                "pipeline_template_begin",
                remaining_s=round(remaining, 1),
                template_position=f"{idx + 1}/{len(templates)}",
            )
            tpl_t0 = time.time()
            try:
                # Re-check credentials before each template (a previous template
                # in this run may have created them via save_credentials)
                if not agent_creds:
                    agent_creds = _load_agent_credentials(supabase, project_id)
                    if agent_creds:
                        tpl_log.info(
                            "pipeline_credentials_resolved_midrun",
                            email=agent_creds["email"],
                        )

                result = await execute_single_template(
                    supabase, project, template, test_run_id, integrations,
                    agentmail_address=agentmail_address,
                    agentmail_inbox_id=agentmail_inbox_id,
                    existing_credentials=agent_creds,
                    generated_password=generated_password,
                    chat_session_id=chat_session_id,
                )
                tpl_elapsed = time.time() - tpl_t0
                tpl_log.info(
                    "pipeline_template_ok",
                    status=result.get("status"),
                    duration_ms=result.get("duration_ms", 0),
                    elapsed_s=round(tpl_elapsed, 3),
                )

                # If the agent saved credentials during this template, reload them
                if result.get("console_logs", {}).get("credentials_saved"):
                    agent_creds = _load_agent_credentials(supabase, project_id)
                    if agent_creds:
                        tpl_log.info(
                            "pipeline_credentials_saved_midrun",
                            email=agent_creds["email"],
                        )

                results.append(result)
            except Exception as e:
                tpl_elapsed = time.time() - tpl_t0
                duration_ms = int(tpl_elapsed * 1000)
                tpl_log.error(
                    "pipeline_template_failed",
                    elapsed_s=round(tpl_elapsed, 3),
                    err_type=type(e).__name__,
                    err=str(e),
                    traceback=traceback.format_exc(),
                )
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

        log.info(
            "pipeline_aggregate_results",
            **summary,
        )

        # 9. Update test run as completed
        log.info("pipeline_status_update", new_status="completed")
        supabase.table("test_runs").update({
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": summary,
        }).eq("id", test_run_id).execute()

        # 10. Send Slack report
        log.info("pipeline_send_report_begin")
        try:
            await send_report(supabase, project, integrations, test_run_id, results, summary)
            log.info("pipeline_send_report_ok")
        except Exception as e:
            log.warn(
                "pipeline_send_report_failed",
                err_type=type(e).__name__,
                err=str(e),
            )

        pipeline_elapsed = time.time() - pipeline_t0
        log.info(
            "pipeline_ok",
            elapsed_s=round(pipeline_elapsed, 3),
            **summary,
        )

    except Exception as e:
        pipeline_elapsed = time.time() - pipeline_t0
        log.error(
            "pipeline_failed",
            elapsed_s=round(pipeline_elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
            traceback=traceback.format_exc(),
        )
        supabase.table("test_runs").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "summary": {"error": str(e), "traceback": traceback.format_exc()},
        }).eq("id", test_run_id).execute()
        raise


async def upload_screenshots(supabase, screenshots: list[dict], test_run_id: str, template_name: str) -> list[str]:
    """Upload screenshot PNGs to Supabase Storage and return public URLs."""
    import base64

    log = bind(
        "modal_test_runner",
        test_run_id=test_run_id,
        template_name=template_name,
    )
    log.info(
        "pipeline_upload_screenshots_begin",
        screenshot_count=len(screenshots),
    )
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
            log.warn(
                "pipeline_upload_screenshot_failed",
                screenshot_index=i,
                label=shot.get("label"),
                err_type=type(e).__name__,
                err=str(e),
            )

    log.info(
        "pipeline_upload_screenshots_ok",
        uploaded=len(urls),
        screenshot_count=len(screenshots),
    )
    return urls


async def execute_single_template(
    supabase,
    project,
    template,
    test_run_id: str,
    integrations: dict | None = None,
    agentmail_address: str | None = None,
    agentmail_inbox_id: str | None = None,
    existing_credentials: dict | None = None,
    generated_password: str | None = None,
    chat_session_id: str | None = None,
) -> dict:
    """Execute a single test template in an isolated browser session."""
    tpl_name = template.get("name", "unnamed")
    tpl_id = template["id"]
    project_id = project["id"]
    start_time = datetime.now(timezone.utc)
    t0 = time.time()
    integrations = integrations or {}
    browserbase_session_id: str | None = None
    live_chat_message_id: str | None = None

    log = bind(
        "modal_test_runner",
        test_run_id=test_run_id,
        project_id=project_id,
        template_id=tpl_id,
        template_name=tpl_name,
    )
    log.info("template_execute_start")

    # Pre-test observability snapshot
    pre_snapshot: dict = {}
    try:
        log.info("template_observability_pre_begin")
        pre_snapshot = await collect_observability_data(integrations, window_minutes=1)
        log.info(
            "template_observability_pre_ok",
            keys=list(pre_snapshot.keys()),
        )
    except Exception as e:
        log.warn(
            "template_observability_pre_failed",
            err_type=type(e).__name__,
            err=str(e),
        )

    client = None
    session = None
    page = None
    playwright_inst = None
    browser = None

    async def on_credentials_saved(email: str, password: str) -> None:
        """Callback invoked when the agent calls save_credentials."""
        await _save_agent_credentials(supabase, project_id, email, password)

    try:
        log.info("template_browser_session_begin")
        session_ctx = await create_stagehand_session()
        client = session_ctx["client"]
        session = session_ctx["session"]
        page = session_ctx["page"]
        playwright_inst = session_ctx["playwright"]
        browser = session_ctx["browser"]
        browserbase_session_id = session_ctx["session_id"]

        log.info(
            "template_browser_session_ready",
            browserbase_session_id=browserbase_session_id,
        )

        # If this run originated from chat, post a live-session message so
        # the user can watch the test execute in realtime from the chat.
        if chat_session_id and browserbase_session_id:
            live_chat_message_id = _insert_live_session_chat_message(
                supabase,
                chat_session_id=chat_session_id,
                test_run_id=test_run_id,
                test_template_id=tpl_id,
                template_name=tpl_name,
                browserbase_session_id=browserbase_session_id,
                live_view_url=session_ctx.get("live_view_url"),
                live_view_fullscreen_url=session_ctx.get("live_view_fullscreen_url"),
                live_view_debugger_url=session_ctx.get("live_view_debugger_url"),
            )

        # Navigate to the app URL before starting the test loop
        app_url = project.get("app_url", "")
        if app_url:
            log.info("template_initial_navigate_begin", app_url=app_url)
            await page.goto(app_url, wait_until="domcontentloaded", timeout=30000)
            log.info("template_initial_navigate_ok", url=page.url)

        # Execute the test template (auth is now handled inside the ReAct loop)
        log.info("template_react_loop_begin")
        exec_t0 = time.time()
        agent_result = await execute_template(
            session, page, template, project, integrations,
            agentmail_address=agentmail_address,
            agentmail_inbox_id=agentmail_inbox_id,
            existing_credentials=existing_credentials,
            generated_password=generated_password,
            on_credentials_saved=on_credentials_saved,
        )
        exec_elapsed = time.time() - exec_t0
        llm_err = agent_result.get("llm_error")
        hit_lim = agent_result.get("hit_iteration_limit")
        log.info(
            "template_react_loop_ok",
            elapsed_s=round(exec_elapsed, 3),
            passed=agent_result.get("passed"),
            iterations_used=agent_result.get("iterations_used"),
            max_iterations=agent_result.get("max_iterations"),
            hit_iteration_limit=hit_lim,
            llm_error_present=bool(llm_err),
            llm_error=(llm_err[:500] + "…") if llm_err and len(llm_err) > 500 else llm_err,
            bug_count=len(agent_result.get("bugs_found", [])),
            screenshot_count=len(agent_result.get("screenshots", [])),
        )

        test_passed = agent_result.get("passed", False)
        status = "passed" if test_passed else "failed"
        error_message = None if test_passed else agent_result.get("summary", "Test failed")

        bugs = agent_result.get("bugs_found", [])
        if bugs and status == "passed":
            status = "failed"
            error_message = "; ".join(b.get("description", "") for b in bugs)
            log.info(
                "template_status_overridden_bugs",
                bug_count=len(bugs),
            )

        duration_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)

        # Post-test observability snapshot
        observability_errors: dict = {}
        try:
            log.info("template_observability_post_begin")
            await asyncio.sleep(3)
            post_snapshot = await collect_observability_data(integrations, window_minutes=2)
            observability_errors = diff_observability_snapshots(pre_snapshot, post_snapshot)
            log.info(
                "template_observability_post_ok",
                new_error_sources=list(observability_errors.keys()),
            )
        except Exception as e:
            log.warn(
                "template_observability_post_failed",
                err_type=type(e).__name__,
                err=str(e),
            )

        if observability_errors and status == "passed":
            status = "failed"
            error_sources = [k for k, v in observability_errors.items() if v]
            error_message = f"Observability errors detected in: {', '.join(error_sources)}"
            log.info(
                "template_status_overridden_observability",
                error_sources=error_sources,
            )

        # Upload screenshots
        screenshot_urls: list[str] = []
        raw_screenshots = agent_result.get("screenshots", [])
        if raw_screenshots:
            try:
                screenshot_urls = await upload_screenshots(
                    supabase, raw_screenshots, test_run_id,
                    template.get("name", "unknown"),
                )
            except Exception as e:
                log.warn(
                    "template_screenshot_upload_failed",
                    err_type=type(e).__name__,
                    err=str(e),
                )

        # Save Browserbase session recording
        recording_url = None
        if browserbase_session_id:
            log.info(
                "template_save_recording_begin",
                browserbase_session_id=browserbase_session_id,
            )
            try:
                recording_url = await save_session_recording(
                    supabase,
                    browserbase_session_id,
                    test_run_id,
                    template.get("name", "unknown"),
                )
                log.info(
                    "template_save_recording_ok",
                    recording_url=recording_url,
                    had_url=bool(recording_url),
                )
            except Exception as e:
                log.warn(
                    "template_save_recording_failed",
                    err_type=type(e).__name__,
                    err=str(e),
                )

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
                "llm_error": agent_result.get("llm_error"),
                "observability": observability_errors,
                "credentials_saved": agent_result.get("credentials_saved", False),
            },
        }

        log.info(
            "template_insert_result",
            status=status,
            duration_ms=duration_ms,
        )
        supabase.table("test_results").insert(result).execute()

        # Finalize the chat live-session bubble (if any) so the UI flips
        # from the live iframe to the completed state with the recording.
        if live_chat_message_id:
            _update_live_session_chat_message(
                supabase,
                live_chat_message_id,
                status=status,
                recording_url=recording_url,
                error_message=error_message,
                duration_ms=duration_ms,
            )

        total_elapsed = time.time() - t0
        log.info(
            "template_execute_ok",
            elapsed_s=round(total_elapsed, 3),
            status=status,
        )
        return result

    except Exception as e:
        total_elapsed = time.time() - t0
        log.error(
            "template_execute_failed",
            elapsed_s=round(total_elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
            traceback=traceback.format_exc(),
        )
        if live_chat_message_id:
            _update_live_session_chat_message(
                supabase,
                live_chat_message_id,
                status="error",
                recording_url=None,
                error_message=str(e),
                duration_ms=int((time.time() - t0) * 1000),
            )
        raise

    finally:
        log.info(
            "template_cleanup_session",
            browserbase_session_id=browserbase_session_id,
        )
        await cleanup_session(client, session, browser, playwright_inst)
