"""
Agentic test executor — ReAct loop powered by Claude Opus (outer reasoning)
and Stagehand session.execute() (inner browser actions via Stagehand v3 API).

Architecture:
  Outer loop (Claude Opus):  observe screenshot → reason → pick tool → repeat
  Inner loop (Stagehand v3): session.execute(instruction) performs
      multi-step browser interactions within a single action
"""
import asyncio
import base64
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Awaitable

from anthropic import Anthropic
from agentmail import AgentMail

from runner.browser import stagehand_agent_model_config
from runner.prompts import (
    OUTER_AGENT_MODEL,
    STAGEHAND_AGENT_MODEL,
    TOOLS,
    build_system_prompt,
    build_tool_result_content,
)


async def capture_page_state(page) -> dict:
    """Capture a snapshot of the current browser page state via Playwright."""
    url = ""
    screenshot_b64 = ""
    try:
        url = page.url
    except Exception:
        pass

    try:
        raw = await page.screenshot(type="png")
        if isinstance(raw, bytes):
            screenshot_b64 = base64.b64encode(raw).decode("ascii")
        elif isinstance(raw, str):
            screenshot_b64 = raw
    except Exception as e:
        print(f"[EXECUTOR] WARNING: screenshot capture failed: {type(e).__name__}: {e}")

    return {
        "url": url,
        "screenshot_base64": screenshot_b64,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def execute_browser_action(session, page, instruction: str) -> dict:
    """Run a single instruction through the Stagehand v3 execute (agent) endpoint.

    Returns a dict with the execution outcome and post-action page state.
    """
    success = True
    error: str | None = None
    agent_output: str | None = None

    t0 = time.time()
    try:
        response = await session.execute(
            execute_options={
                "instruction": instruction,
                "max_steps": 10,
            },
            agent_config={
                "model": stagehand_agent_model_config(),
                "mode": "cua",
                "system_prompt": "You are a QA tester executing test steps on a web application. Be precise and wait for elements to load before interacting.",
            },
            timeout=120.0,
        )
        elapsed = time.time() - t0
        result_data = response.data.result
        agent_output = result_data.message
        if not result_data.success:
            success = False
            error = result_data.message or "Agent execute reported failure"
            print(f"[EXECUTOR]     execute returned success=false ({elapsed:.1f}s): {error}")
        else:
            print(f"[EXECUTOR]     execute succeeded ({elapsed:.1f}s): {(agent_output or '')[:120]}")
    except Exception as e:
        elapsed = time.time() - t0
        success = False
        error = str(e)
        print(f"[EXECUTOR]     execute EXCEPTION ({elapsed:.1f}s): {type(e).__name__}: {e}")

    await asyncio.sleep(1)
    page_state = await capture_page_state(page)

    return {
        "success": success,
        "error": error,
        "agent_output": agent_output,
        "page_state": page_state,
    }


async def execute_observe_dom(session, query: str) -> dict:
    """Run a DOM-level observation via Stagehand v3 observe endpoint."""
    t0 = time.time()
    try:
        response = await session.observe(
            instruction=query,
            options={"model": stagehand_agent_model_config()},
        )
        elapsed = time.time() - t0
        results = response.data.result
        found = bool(results and len(results) > 0)
        if found:
            observations_str = str([
                {"description": r.description, "selector": r.selector}
                for r in results
            ])
            print(f"[EXECUTOR]     observe found {len(results)} element(s) ({elapsed:.1f}s)")
        else:
            observations_str = "No matching elements found."
            print(f"[EXECUTOR]     observe found 0 elements ({elapsed:.1f}s)")
        return {
            "found": found,
            "observations": observations_str,
        }
    except Exception as e:
        elapsed = time.time() - t0
        print(f"[EXECUTOR]     observe EXCEPTION ({elapsed:.1f}s): {type(e).__name__}: {e}")
        return {
            "found": False,
            "observations": f"Observation failed: {e}",
        }


_EMAIL_TEXT_MAX_CHARS = 4000

_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)

_VERIFICATION_URL_KEYWORDS = re.compile(
    r"verif|confirm|activate|validate|auth|token|callback|register|signup|sign-up|magic.link|otp",
    re.IGNORECASE,
)


def _extract_urls(text: str) -> tuple[list[str], list[str]]:
    """Extract URLs from *text*.

    Returns ``(all_urls, verification_urls)`` where *verification_urls* is the
    subset whose path/query contains keywords typical of email-verification or
    confirmation links.
    """
    all_urls: list[str] = []
    verification_urls: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(text):
        url = m.group(0).rstrip(".,;:!?")
        if url in seen:
            continue
        seen.add(url)
        all_urls.append(url)
        if _VERIFICATION_URL_KEYWORDS.search(url):
            verification_urls.append(url)
    return all_urls, verification_urls


async def execute_check_email(
    agentmail_inbox_id: str | None,
    since: datetime,
    timeout_seconds: int = 30,
) -> dict:
    """Poll AgentMail inbox for recent messages and return them."""
    if not agentmail_inbox_id:
        return {
            "success": False,
            "messages": [],
            "summary": "No email inbox configured for this project.",
        }

    api_key = os.environ.get("AGENTMAIL_API_KEY", "")
    if not api_key:
        return {
            "success": False,
            "messages": [],
            "summary": "AgentMail API key not configured.",
        }

    agentmail = AgentMail(api_key=api_key)
    poll_start = time.time()
    found_messages: list[dict] = []
    poll_count = 0

    while (time.time() - poll_start) < timeout_seconds:
        poll_count += 1
        try:
            list_resp = agentmail.inboxes.messages.list(inbox_id=agentmail_inbox_id, limit=10)
            rows = list_resp.messages or []
        except Exception as e:
            print(f"[EXECUTOR]     check_email poll #{poll_count}: list failed: {type(e).__name__}: {e}")
            await asyncio.sleep(2)
            continue

        for msg in rows:
            msg_date = msg.created_at
            if msg_date.tzinfo is None:
                msg_date = msg_date.replace(tzinfo=timezone.utc)
            if msg_date < since:
                continue

            text = (msg.text or msg.subject or msg.preview or "") or ""
            subject = msg.subject or ""
            code_match = re.search(r"\b(\d{4,8})\b", text)
            all_urls, verification_urls = _extract_urls(text)

            found_messages.append({
                "subject": subject,
                "text": text[:_EMAIL_TEXT_MAX_CHARS],
                "code": code_match.group(1) if code_match else None,
                "urls": all_urls,
                "verification_urls": verification_urls,
                "received_at": msg_date.isoformat(),
            })

        if found_messages:
            break

        elapsed = time.time() - poll_start
        print(f"[EXECUTOR]     check_email poll #{poll_count}: no messages yet ({elapsed:.0f}s / {timeout_seconds}s)")
        await asyncio.sleep(2)

    if not found_messages:
        return {
            "success": True,
            "messages": [],
            "summary": f"No new messages received within {timeout_seconds}s ({poll_count} polls).",
        }

    print(f"[EXECUTOR]     check_email: found {len(found_messages)} message(s) after {poll_count} poll(s)")
    return {
        "success": True,
        "messages": found_messages,
        "summary": f"Found {len(found_messages)} message(s).",
    }


def _strip_images_from_message(msg: dict) -> dict:
    """Return a copy of *msg* with image blocks replaced by text placeholders."""
    content = msg.get("content")
    if content is None or isinstance(content, str):
        return msg
    if not isinstance(content, list):
        return msg

    new_content: list = []
    for block in content:
        if isinstance(block, dict):
            if block.get("type") == "image":
                new_content.append({"type": "text", "text": "[Screenshot — removed from context]"})
            elif block.get("type") == "tool_result":
                inner = block.get("content")
                if isinstance(inner, list):
                    new_inner: list = []
                    for ib in inner:
                        if isinstance(ib, dict) and ib.get("type") == "image":
                            new_inner.append({"type": "text", "text": "[Screenshot — removed from context]"})
                        else:
                            new_inner.append(ib)
                    new_content.append({**block, "content": new_inner})
                else:
                    new_content.append(block)
            else:
                new_content.append(block)
        else:
            new_content.append(block)

    return {**msg, "content": new_content}


def _compress_messages(
    messages: list[dict],
    keep_recent_images: int = 8,
) -> list[dict]:
    """Strip screenshot images from older messages to manage context size."""
    if len(messages) <= keep_recent_images:
        return messages

    cutoff = len(messages) - keep_recent_images
    return [
        _strip_images_from_message(msg) if i < cutoff else msg
        for i, msg in enumerate(messages)
    ]


async def execute_template(
    session,
    page,
    template: dict,
    project: dict,
    integrations: dict[str, dict] | None = None,
    agentmail_address: str | None = None,
    agentmail_inbox_id: str | None = None,
    existing_credentials: dict | None = None,
    generated_password: str | None = None,
    on_credentials_saved: Callable[[str, str], Awaitable[None]] | None = None,
) -> dict:
    """Execute a test template using the agentic ReAct loop.

    Args:
        session: Stagehand v3 AsyncSession (for AI-powered act/observe/execute)
        page: Playwright Page (for screenshots and direct navigation)
        template: Test template dict from DB
        project: Project dict from DB
        integrations: Integration configs
        agentmail_address: The AgentMail email address for signup/2FA
        agentmail_inbox_id: The AgentMail inbox ID for polling emails
        existing_credentials: Dict with 'email' and 'password' if previously created
        generated_password: Pre-generated password for first-run signup
        on_credentials_saved: Async callback invoked when the agent calls save_credentials
    """
    tpl_name = template.get("name", "unnamed")
    app_url = project.get("app_url", "?")
    steps = template.get("steps", [])
    if isinstance(steps, str):
        steps = json.loads(steps)
    steps = sorted(steps, key=lambda s: s.get("order", 0))

    auth_extra = 15 if not existing_credentials and agentmail_address else 8
    max_iterations = max(len(steps) * 10, 10) + auth_extra

    print(f"[EXECUTOR] execute_template — {tpl_name!r}")
    print(f"[EXECUTOR]   app_url        = {app_url}")
    print(f"[EXECUTOR]   steps          = {len(steps)}")
    print(f"[EXECUTOR]   max_iterations = {max_iterations}")
    print(f"[EXECUTOR]   outer model    = {OUTER_AGENT_MODEL}")
    print(f"[EXECUTOR]   inner model    = {STAGEHAND_AGENT_MODEL}")
    print(f"[EXECUTOR]   has_credentials = {existing_credentials is not None}")
    print(f"[EXECUTOR]   agentmail      = {agentmail_address or 'none'}")

    anthropic = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    system_prompt = build_system_prompt(
        template,
        project,
        integrations,
        agentmail_address=agentmail_address,
        existing_credentials=existing_credentials,
        generated_password=generated_password,
    )

    test_start_time = datetime.now(timezone.utc)

    print("[EXECUTOR] Capturing initial page state...")
    initial_state = await capture_page_state(page)
    print(f"[EXECUTOR]   initial url        = {initial_state['url']}")
    print(f"[EXECUTOR]   has screenshot     = {bool(initial_state['screenshot_base64'])}")

    initial_content: list[dict] = [
        {"type": "text", "text": (
            f"The browser is open at {initial_state['url']}.\n"
            "Here is a screenshot of the current page state. "
            "Review the authentication instructions and test plan in your system prompt, then begin."
        )},
    ]
    if initial_state["screenshot_base64"]:
        initial_content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": initial_state["screenshot_base64"],
            },
        })

    messages: list[dict] = [{"role": "user", "content": initial_content}]

    actions: list[dict] = []
    screenshots: list[dict] = []
    test_passed = False
    test_summary = ""
    bugs_found: list[dict] = []
    completed = False
    llm_error: str | None = None
    iterations_used = 0
    credentials_saved = False

    if initial_state["screenshot_base64"]:
        screenshots.append({
            "label": "initial_state",
            "base64": initial_state["screenshot_base64"],
            "url": initial_state["url"],
            "timestamp": initial_state["timestamp"],
        })

    loop_t0 = time.time()

    for iteration in range(max_iterations):
        iterations_used = iteration + 1
        messages = _compress_messages(messages, keep_recent_images=12)

        print(f"[EXECUTOR] --- Iteration {iteration}/{max_iterations - 1} (messages={len(messages)}) ---")

        # Call outer agent (Claude Opus)
        llm_t0 = time.time()
        try:
            response = anthropic.messages.create(
                model=OUTER_AGENT_MODEL,
                max_tokens=21000,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )
            llm_elapsed = time.time() - llm_t0
            print(f"[EXECUTOR]   LLM call: {llm_elapsed:.1f}s  stop_reason={response.stop_reason}  "
                  f"usage=in:{response.usage.input_tokens}/out:{response.usage.output_tokens}")
        except Exception as e:
            llm_elapsed = time.time() - llm_t0
            llm_error = str(e)
            print(f"[EXECUTOR]   LLM EXCEPTION ({llm_elapsed:.1f}s): {type(e).__name__}: {e}")
            actions.append({
                "iteration": iteration,
                "tool": "llm_error",
                "error": llm_error,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            break

        assistant_content = response.content
        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn":
            text_parts = [
                b.text for b in assistant_content
                if hasattr(b, "text")
            ]
            test_summary = " ".join(text_parts) if text_parts else "Agent ended without explicit completion."
            print(f"[EXECUTOR]   Agent ended turn (no tool call). Summary preview: {test_summary[:150]}")
            completed = True
            break

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        if not tool_use_blocks:
            print("[EXECUTOR]   No tool_use blocks and stop_reason != end_turn — treating as completed")
            completed = True
            break

        tool_results: list[dict] = []

        for tool_block in tool_use_blocks:
            tool_name = tool_block.name
            tool_input = tool_block.input or {}
            tool_id = tool_block.id

            action_record: dict[str, Any] = {
                "iteration": iteration,
                "tool": tool_name,
                "input": tool_input,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            if tool_name == "browser_action":
                instruction = tool_input.get("instruction", "")
                print(f"[EXECUTOR]   tool: browser_action — {instruction[:120]}")

                result = await execute_browser_action(session, page, instruction)
                action_record["success"] = result["success"]
                action_record["error"] = result["error"]
                action_record["url_after"] = result["page_state"]["url"]
                action_record["instruction"] = instruction

                if result["success"]:
                    result_text = result["agent_output"] or "Action completed successfully."
                else:
                    result_text = f"Action failed: {result['error']}"

                content = build_tool_result_content(
                    result["page_state"]["screenshot_base64"],
                    result["page_state"]["url"],
                    result_text,
                )

                if result["page_state"]["screenshot_base64"]:
                    screenshots.append({
                        "label": f"iter_{iteration}_{tool_name}",
                        "base64": result["page_state"]["screenshot_base64"],
                        "url": result["page_state"]["url"],
                        "timestamp": result["page_state"]["timestamp"],
                    })

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": content,
                })

            elif tool_name == "observe_dom":
                query = tool_input.get("query", "")
                print(f"[EXECUTOR]   tool: observe_dom — {query[:120]}")

                result = await execute_observe_dom(session, query)
                action_record["found"] = result["found"]
                action_record["observations"] = result["observations"][:500]

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result["observations"],
                })

            elif tool_name == "save_credentials":
                cred_email = tool_input.get("email", "")
                cred_password = tool_input.get("password", "")
                print(f"[EXECUTOR]   tool: save_credentials — email={cred_email}")

                if on_credentials_saved and cred_email and cred_password:
                    try:
                        await on_credentials_saved(cred_email, cred_password)
                        credentials_saved = True
                        action_record["success"] = True
                        print("[EXECUTOR]     credentials saved successfully")
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": "Credentials saved successfully. They will be available on future test runs.",
                        })
                    except Exception as e:
                        action_record["success"] = False
                        action_record["error"] = str(e)
                        print(f"[EXECUTOR]     save_credentials FAILED: {type(e).__name__}: {e}")
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": f"Failed to save credentials: {e}. Proceed with testing anyway.",
                            "is_error": True,
                        })
                else:
                    msg = "Missing email or password." if not (cred_email and cred_password) else "No credential storage handler configured."
                    action_record["success"] = False
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": f"Could not save credentials: {msg}",
                        "is_error": True,
                    })

            elif tool_name == "check_email":
                timeout_secs = tool_input.get("timeout_seconds", 30)
                print(f"[EXECUTOR]   tool: check_email — timeout={timeout_secs}s")

                result = await execute_check_email(
                    agentmail_inbox_id,
                    since=test_start_time,
                    timeout_seconds=timeout_secs,
                )
                action_record["success"] = result["success"]
                action_record["message_count"] = len(result["messages"])

                if result["messages"]:
                    msg_lines = []
                    for m in result["messages"]:
                        line = f"Subject: {m['subject']}\n"
                        if m["code"]:
                            line += f"Verification code found: {m['code']}\n"
                        if m.get("verification_urls"):
                            line += "Verification/confirmation links found:\n"
                            for vu in m["verification_urls"]:
                                line += f"  - {vu}\n"
                        elif m.get("urls"):
                            line += "Links found:\n"
                            for u in m["urls"][:10]:
                                line += f"  - {u}\n"
                        line += f"Body: {m['text']}"
                        msg_lines.append(line)
                    response_text = f"{result['summary']}\n\n" + "\n---\n".join(msg_lines)
                else:
                    response_text = result["summary"]

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": response_text,
                })

            elif tool_name == "complete_test":
                test_passed = tool_input.get("passed", False)
                test_summary = tool_input.get("summary", "")
                bugs_found = tool_input.get("bugs_found", [])

                print(f"[EXECUTOR]   tool: complete_test — passed={test_passed}  bugs={len(bugs_found)}")
                print(f"[EXECUTOR]     summary: {test_summary[:200]}")
                for bug in bugs_found:
                    print(f"[EXECUTOR]     bug: [{bug.get('severity', '?')}] {bug.get('description', '?')[:120]}")

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": "Test completion recorded.",
                })

                actions.append(action_record)
                messages.append({"role": "user", "content": tool_results})
                completed = True
                break

            else:
                print(f"[EXECUTOR]   tool: UNKNOWN — {tool_name}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": f"Unknown tool: {tool_name}",
                    "is_error": True,
                })

            actions.append(action_record)

        if completed:
            break

        messages.append({"role": "user", "content": tool_results})

    loop_elapsed = time.time() - loop_t0

    if llm_error is not None:
        test_summary = f"Outer LLM call failed: {llm_error}"
        print(f"[EXECUTOR] WARNING: LLM failure — {llm_error}")
    elif not completed:
        test_summary = f"Test execution hit the iteration limit ({max_iterations}). The test flow may be incomplete."
        print(f"[EXECUTOR] WARNING: Hit iteration limit ({max_iterations})")

    print(f"[EXECUTOR] execute_template — finished")
    print(f"[EXECUTOR]   loop time    = {loop_elapsed:.1f}s")
    print(f"[EXECUTOR]   iterations   = {iterations_used}/{max_iterations}")
    print(f"[EXECUTOR]   passed       = {test_passed}")
    print(f"[EXECUTOR]   completed    = {completed}")
    print(f"[EXECUTOR]   actions      = {len(actions)}")
    print(f"[EXECUTOR]   screenshots  = {len(screenshots)}")
    print(f"[EXECUTOR]   bugs         = {len(bugs_found)}")
    print(f"[EXECUTOR]   creds_saved  = {credentials_saved}")

    return {
        "passed": test_passed,
        "summary": test_summary,
        "bugs_found": bugs_found,
        "actions": actions,
        "screenshots": screenshots,
        "iterations_used": iterations_used,
        "max_iterations": max_iterations,
        "hit_iteration_limit": not completed and llm_error is None,
        "llm_error": llm_error,
        "credentials_saved": credentials_saved,
    }
