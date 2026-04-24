"""
Agentic test executor — ReAct loop powered by Claude Opus 4.7 (outer
reasoning, via `langchain-anthropic`) and Stagehand session.execute() (inner
browser actions via Stagehand v3 API, backed by Claude Opus 4.6).

Architecture:
  Outer loop (Claude Opus 4.7): observe screenshot → reason → pick tool →
    repeat. Uses our own `{name, description, input_schema}` tool schema,
    NOT the Anthropic native `computer_` tool — so this layer is immune to
    the Stagehand CUA tool-schema issue that forces the inner agent to
    stay on 4.6.
  Inner loop (Stagehand v3 + Claude Opus 4.6): session.execute(instruction)
    performs multi-step browser interactions within a single action.
"""
import asyncio
import base64
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable, Awaitable

from agentmail import AgentMail
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from runner.browser import stagehand_agent_model_config
from runner.chat.models import get_claude_opus_outer
from runner.logging import test_log
from runner.prompts import (
    OUTER_AGENT_MODEL,
    STAGEHAND_AGENT_MODEL,
    TOOLS,
    build_system_prompt,
)


# ---------------------------------------------------------------------------
# Tool schema
# ---------------------------------------------------------------------------
# `runner.prompts.TOOLS` is authored in Anthropic's native shape
# (`{name, description, input_schema}`), which `langchain-anthropic`'s
# `bind_tools` accepts directly. The outer agent is Claude Opus 4.7, so no
# OpenAI/Gemini-style function-calling shape conversion is needed.
_LANGCHAIN_TOOLS = list(TOOLS)


# ---------------------------------------------------------------------------
# Page state helpers
# ---------------------------------------------------------------------------


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
        test_log(
            "warn",
            "executor_screenshot_capture_failed",
            err_type=type(e).__name__,
            err=str(e),
        )

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
            test_log(
                "warn",
                "executor_browser_action_reported_failure",
                elapsed_s=round(elapsed, 3),
                error=error,
                instruction=instruction[:200],
            )
        else:
            test_log(
                "info",
                "executor_browser_action_ok",
                elapsed_s=round(elapsed, 3),
                agent_output_preview=(agent_output or "")[:200],
                instruction=instruction[:200],
            )
    except Exception as e:
        elapsed = time.time() - t0
        success = False
        error = str(e)
        test_log(
            "error",
            "executor_browser_action_exception",
            elapsed_s=round(elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
            instruction=instruction[:200],
        )

    await asyncio.sleep(1)
    page_state = await capture_page_state(page)

    return {
        "success": success,
        "error": error,
        "agent_output": agent_output,
        "page_state": page_state,
    }


async def execute_navigate_to_url(page, url: str) -> dict:
    """Navigate the browser directly to a URL via Playwright page.goto().

    This bypasses the Stagehand CUA agent entirely, providing reliable
    programmatic navigation for known URLs (verification links, callbacks, etc.).
    """
    success = True
    error: str | None = None

    t0 = time.time()
    try:
        response = await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        elapsed = time.time() - t0
        status = response.status if response else None
        test_log(
            "info",
            "executor_navigate_ok",
            elapsed_s=round(elapsed, 3),
            http_status=status,
            requested_url=url,
            final_url=page.url,
        )
    except Exception as e:
        elapsed = time.time() - t0
        success = False
        error = str(e)
        test_log(
            "error",
            "executor_navigate_exception",
            elapsed_s=round(elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
            requested_url=url,
        )

    await asyncio.sleep(1)
    page_state = await capture_page_state(page)

    return {
        "success": success,
        "error": error,
        "page_state": page_state,
    }


async def execute_observe_dom(session, query: str) -> dict:
    """Run a DOM-level observation via Stagehand v3 observe endpoint."""
    t0 = time.time()
    try:
        response = await session.observe(
            instruction=query,
            options={"model": stagehand_agent_model_config(prefixed=True)},
        )
        elapsed = time.time() - t0
        results = response.data.result
        found = bool(results and len(results) > 0)
        if found:
            observations_str = str([
                {"description": r.description, "selector": r.selector}
                for r in results
            ])
            test_log(
                "info",
                "executor_observe_ok",
                elapsed_s=round(elapsed, 3),
                element_count=len(results),
                query=query[:200],
            )
        else:
            observations_str = "No matching elements found."
            test_log(
                "info",
                "executor_observe_empty",
                elapsed_s=round(elapsed, 3),
                query=query[:200],
            )
        return {
            "found": found,
            "observations": observations_str,
        }
    except Exception as e:
        elapsed = time.time() - t0
        test_log(
            "error",
            "executor_observe_exception",
            elapsed_s=round(elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
            query=query[:200],
        )
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
            test_log(
                "warn",
                "executor_check_email_list_failed",
                poll_number=poll_count,
                err_type=type(e).__name__,
                err=str(e),
            )
            await asyncio.sleep(2)
            continue

        for msg in rows:
            msg_date = msg.created_at
            if msg_date.tzinfo is None:
                msg_date = msg_date.replace(tzinfo=timezone.utc)
            if msg_date < since:
                continue

            # MessageItem (from list) lacks .text — fetch the full Message
            html = ""
            try:
                full_msg = agentmail.inboxes.messages.get(
                    inbox_id=agentmail_inbox_id, message_id=msg.message_id
                )
                text = (full_msg.text or full_msg.extracted_text or full_msg.subject or full_msg.preview or "")
                html = (full_msg.html or "")
            except Exception:
                text = (msg.subject or msg.preview or "")

            subject = msg.subject or ""
            code_match = re.search(r"\b(\d{4,8})\b", text)
            all_urls, verification_urls = _extract_urls(text)

            # Some emails are HTML-only (no text/plain part). Extract URLs
            # from the HTML body as a fallback so confirmation links aren't missed.
            if html:
                import html as html_mod
                decoded_html = html_mod.unescape(html)
                html_urls, html_verif_urls = _extract_urls(decoded_html)
                seen = set(all_urls)
                for u in html_urls:
                    if u not in seen:
                        all_urls.append(u)
                        seen.add(u)
                seen_v = set(verification_urls)
                for u in html_verif_urls:
                    if u not in seen_v:
                        verification_urls.append(u)
                        seen_v.add(u)

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
        test_log(
            "debug",
            "executor_check_email_poll_empty",
            poll_number=poll_count,
            elapsed_s=round(elapsed, 1),
            timeout_seconds=timeout_seconds,
        )
        await asyncio.sleep(2)

    if not found_messages:
        return {
            "success": True,
            "messages": [],
            "summary": f"No new messages received within {timeout_seconds}s ({poll_count} polls).",
        }

    test_log(
        "info",
        "executor_check_email_ok",
        message_count=len(found_messages),
        poll_count=poll_count,
    )
    return {
        "success": True,
        "messages": found_messages,
        "summary": f"Found {len(found_messages)} message(s).",
    }


# ---------------------------------------------------------------------------
# Message construction helpers (LangChain unified content blocks)
# ---------------------------------------------------------------------------


def _screenshot_message(url: str, screenshot_b64: str, note: str) -> HumanMessage:
    """Build a HumanMessage with a text note + PNG screenshot block.

    `langchain-anthropic` (and `langchain-google-genai`) both accept the
    unified LangChain image content-block shape
    `{type: "image", base64, mime_type}` at the top level of a
    HumanMessage. Screenshots returned from tool calls are delivered this
    way (as a follow-up HumanMessage after the corresponding ToolMessage)
    rather than embedded inside the ToolMessage itself, because some
    providers' image-in-tool-result converters are still buggy (see
    langchain-google#1591) and a separate HumanMessage is universally
    supported.
    """
    content: list[dict[str, Any]] = [
        {"type": "text", "text": f"Current URL: {url}\n\n{note}"},
    ]
    if screenshot_b64:
        content.append(
            {
                "type": "image",
                "base64": screenshot_b64,
                "mime_type": "image/png",
            }
        )
    return HumanMessage(content=content)


def _strip_images_from_content(content: Any) -> Any:
    """Replace image content blocks in a message's `content` with a text placeholder."""
    if content is None or isinstance(content, str):
        return content
    if not isinstance(content, list):
        return content
    new_content: list[Any] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "image":
            new_content.append(
                {"type": "text", "text": "[Screenshot — removed from context]"}
            )
        else:
            new_content.append(block)
    return new_content


def _compress_messages(
    messages: list[BaseMessage],
    keep_recent_images: int = 12,
) -> list[BaseMessage]:
    """Strip screenshot images from older messages to keep context bounded.

    Operates on LangChain `BaseMessage` objects. Messages with string
    content pass through untouched; messages with list content have any
    `image` blocks replaced by a text placeholder. Only the oldest
    messages are stripped; the most recent `keep_recent_images` retain
    their screenshots so the model still sees current visual state.
    """
    if len(messages) <= keep_recent_images:
        return messages

    cutoff = len(messages) - keep_recent_images
    out: list[BaseMessage] = []
    for i, msg in enumerate(messages):
        if i >= cutoff:
            out.append(msg)
            continue
        new_content = _strip_images_from_content(msg.content)
        if new_content is msg.content:
            out.append(msg)
        else:
            out.append(msg.model_copy(update={"content": new_content}))
    return out


def _extract_assistant_text(ai_msg: AIMessage) -> str:
    """Concatenate the text blocks of an AIMessage, for logging + end-turn summary."""
    content = ai_msg.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    t = block.get("text")
                    if isinstance(t, str):
                        parts.append(t)
                elif block.get("type") == "thinking":
                    # Don't include thinking blocks in the visible text summary.
                    continue
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    # Fallback: try LangChain's `.text` accessor if available.
    text = getattr(ai_msg, "text", None)
    return text if isinstance(text, str) else ""


# ---------------------------------------------------------------------------
# Main template executor
# ---------------------------------------------------------------------------


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

    test_log(
        "info",
        "executor_template_begin",
        template_name=tpl_name,
        template_id=template.get("id"),
        project_id=project.get("id"),
        app_url=app_url,
        step_count=len(steps),
        max_iterations=max_iterations,
        outer_model=OUTER_AGENT_MODEL,
        inner_model=STAGEHAND_AGENT_MODEL,
        has_credentials=existing_credentials is not None,
        agentmail_address=agentmail_address,
    )

    system_prompt = build_system_prompt(
        template,
        project,
        integrations,
        agentmail_address=agentmail_address,
        existing_credentials=existing_credentials,
        generated_password=generated_password,
    )

    # Build the outer ReAct model once and bind our custom QA tools.
    # Claude Opus 4.7 accepts Anthropic's native tool shape directly, so
    # `_LANGCHAIN_TOOLS` is the same `TOOLS` list from `runner.prompts`.
    # Defaults (32k output tokens per turn, 5-minute timeout) give the
    # adaptive-thinking reasoning budget plenty of room before a single
    # turn's tool_use block.
    outer_model = get_claude_opus_outer().bind_tools(_LANGCHAIN_TOOLS)

    test_start_time = datetime.now(timezone.utc)

    initial_state = await capture_page_state(page)
    test_log(
        "info",
        "executor_initial_page_state",
        template_name=tpl_name,
        initial_url=initial_state["url"],
        has_screenshot=bool(initial_state["screenshot_base64"]),
    )

    initial_note = (
        "Here is a screenshot of the current page state. "
        "Review the authentication instructions and test plan in your system prompt, then begin."
    )

    messages: list[BaseMessage] = [
        SystemMessage(content=system_prompt),
        _screenshot_message(
            url=initial_state["url"],
            screenshot_b64=initial_state["screenshot_base64"],
            note=(
                f"The browser is open at {initial_state['url']}.\n"
                + initial_note
            ),
        ),
    ]

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

        test_log(
            "debug",
            "executor_iteration_begin",
            template_name=tpl_name,
            iteration=iteration,
            max_iterations=max_iterations,
            message_count=len(messages),
        )

        # Call outer agent (Claude Opus 4.7 via LangChain/Anthropic).
        llm_t0 = time.time()
        try:
            ai_msg: AIMessage = await outer_model.ainvoke(messages)
            llm_elapsed = time.time() - llm_t0
            usage = getattr(ai_msg, "usage_metadata", None) or {}
            test_log(
                "info",
                "executor_llm_call_ok",
                template_name=tpl_name,
                iteration=iteration,
                elapsed_s=round(llm_elapsed, 3),
                tool_call_count=len(getattr(ai_msg, "tool_calls", None) or []),
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
            )
        except Exception as e:
            llm_elapsed = time.time() - llm_t0
            llm_error = str(e)
            test_log(
                "error",
                "executor_llm_call_failed",
                template_name=tpl_name,
                iteration=iteration,
                elapsed_s=round(llm_elapsed, 3),
                err_type=type(e).__name__,
                err=str(e),
            )
            actions.append({
                "iteration": iteration,
                "tool": "llm_error",
                "error": llm_error,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            break

        # CRITICAL: append the AIMessage as-is so reasoning / thinking
        # blocks (Opus adaptive thinking) and the tool_use blocks stay
        # attached for the next turn.
        messages.append(ai_msg)

        tool_calls = getattr(ai_msg, "tool_calls", None) or []

        if not tool_calls:
            # No tool call = end of turn. Use any text the model emitted
            # as the final test summary.
            final_text = _extract_assistant_text(ai_msg).strip()
            test_summary = final_text or "Agent ended without explicit completion."
            test_log(
                "info",
                "executor_agent_end_turn",
                template_name=tpl_name,
                iteration=iteration,
                summary_preview=test_summary[:200],
            )
            completed = True
            break

        # For each tool call: execute, build a ToolMessage with the text
        # result, and (when applicable) follow with a HumanMessage containing
        # the post-action screenshot so the model can observe visually.
        followups: list[BaseMessage] = []
        early_complete = False

        for tool_call in tool_calls:
            tool_name = tool_call.get("name", "")
            tool_input = tool_call.get("args") or {}
            tool_id = tool_call.get("id") or ""

            action_record: dict[str, Any] = {
                "iteration": iteration,
                "tool": tool_name,
                "input": tool_input,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            if tool_name == "browser_action":
                instruction = tool_input.get("instruction", "")
                test_log(
                    "info",
                    "executor_tool_call",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                    instruction=instruction[:200],
                )

                result = await execute_browser_action(session, page, instruction)
                action_record["success"] = result["success"]
                action_record["error"] = result["error"]
                action_record["url_after"] = result["page_state"]["url"]
                action_record["instruction"] = instruction

                if result["success"]:
                    result_text = result["agent_output"] or "Action completed successfully."
                else:
                    result_text = f"Action failed: {result['error']}"

                messages.append(
                    ToolMessage(
                        content=result_text,
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )
                followups.append(
                    _screenshot_message(
                        url=result["page_state"]["url"],
                        screenshot_b64=result["page_state"]["screenshot_base64"],
                        note=f"Result of {tool_name}: {result_text}",
                    )
                )

                if result["page_state"]["screenshot_base64"]:
                    screenshots.append({
                        "label": f"iter_{iteration}_{tool_name}",
                        "base64": result["page_state"]["screenshot_base64"],
                        "url": result["page_state"]["url"],
                        "timestamp": result["page_state"]["timestamp"],
                    })

            elif tool_name == "navigate_to_url":
                nav_url = tool_input.get("url", "")
                test_log(
                    "info",
                    "executor_tool_call",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                    url=nav_url[:200],
                )

                result = await execute_navigate_to_url(page, nav_url)
                action_record["success"] = result["success"]
                action_record["error"] = result["error"]
                action_record["url_after"] = result["page_state"]["url"]
                action_record["url_requested"] = nav_url

                if result["success"]:
                    result_text = f"Successfully navigated to {result['page_state']['url']}"
                else:
                    result_text = f"Navigation failed: {result['error']}"

                messages.append(
                    ToolMessage(
                        content=result_text,
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )
                followups.append(
                    _screenshot_message(
                        url=result["page_state"]["url"],
                        screenshot_b64=result["page_state"]["screenshot_base64"],
                        note=f"Result of {tool_name}: {result_text}",
                    )
                )

                if result["page_state"]["screenshot_base64"]:
                    screenshots.append({
                        "label": f"iter_{iteration}_{tool_name}",
                        "base64": result["page_state"]["screenshot_base64"],
                        "url": result["page_state"]["url"],
                        "timestamp": result["page_state"]["timestamp"],
                    })

            elif tool_name == "observe_dom":
                query = tool_input.get("query", "")
                test_log(
                    "info",
                    "executor_tool_call",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                    query=query[:200],
                )

                result = await execute_observe_dom(session, query)
                action_record["found"] = result["found"]
                action_record["observations"] = result["observations"][:500]

                messages.append(
                    ToolMessage(
                        content=result["observations"],
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )

            elif tool_name == "save_credentials":
                cred_email = tool_input.get("email", "")
                cred_password = tool_input.get("password", "")
                test_log(
                    "info",
                    "executor_tool_call",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                    email=cred_email,
                )

                if on_credentials_saved and cred_email and cred_password:
                    try:
                        await on_credentials_saved(cred_email, cred_password)
                        credentials_saved = True
                        action_record["success"] = True
                        test_log(
                            "info",
                            "executor_save_credentials_ok",
                            template_name=tpl_name,
                            email=cred_email,
                        )
                        messages.append(
                            ToolMessage(
                                content="Credentials saved successfully. They will be available on future test runs.",
                                tool_call_id=tool_id,
                                name=tool_name,
                            )
                        )
                    except Exception as e:
                        action_record["success"] = False
                        action_record["error"] = str(e)
                        test_log(
                            "error",
                            "executor_save_credentials_failed",
                            template_name=tpl_name,
                            err_type=type(e).__name__,
                            err=str(e),
                        )
                        messages.append(
                            ToolMessage(
                                content=f"Failed to save credentials: {e}. Proceed with testing anyway.",
                                tool_call_id=tool_id,
                                name=tool_name,
                                status="error",
                            )
                        )
                else:
                    msg_txt = (
                        "Missing email or password."
                        if not (cred_email and cred_password)
                        else "No credential storage handler configured."
                    )
                    action_record["success"] = False
                    messages.append(
                        ToolMessage(
                            content=f"Could not save credentials: {msg_txt}",
                            tool_call_id=tool_id,
                            name=tool_name,
                            status="error",
                        )
                    )

            elif tool_name == "check_email":
                timeout_secs = tool_input.get("timeout_seconds", 30)
                test_log(
                    "info",
                    "executor_tool_call",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                    timeout_seconds=timeout_secs,
                )

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

                messages.append(
                    ToolMessage(
                        content=response_text,
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )

            elif tool_name == "complete_test":
                test_passed = tool_input.get("passed", False)
                test_summary = tool_input.get("summary", "")
                bugs_found = tool_input.get("bugs_found", [])

                test_log(
                    "info",
                    "executor_complete_test",
                    template_name=tpl_name,
                    iteration=iteration,
                    passed=test_passed,
                    bug_count=len(bugs_found),
                    summary_preview=test_summary[:300],
                    bugs=[
                        {
                            "severity": b.get("severity"),
                            "description": (b.get("description") or "")[:200],
                        }
                        for b in bugs_found
                    ],
                )

                messages.append(
                    ToolMessage(
                        content="Test completion recorded.",
                        tool_call_id=tool_id,
                        name=tool_name,
                    )
                )

                actions.append(action_record)
                early_complete = True
                completed = True
                break

            else:
                test_log(
                    "warn",
                    "executor_tool_call_unknown",
                    template_name=tpl_name,
                    iteration=iteration,
                    tool=tool_name,
                )
                messages.append(
                    ToolMessage(
                        content=f"Unknown tool: {tool_name}",
                        tool_call_id=tool_id,
                        name=tool_name,
                        status="error",
                    )
                )

            actions.append(action_record)

        # Append screenshot follow-ups AFTER all tool results for this turn,
        # so the sequence is:
        #    AIMessage(tool_calls=[...])
        #    ToolMessage(...) * N
        #    HumanMessage(screenshot) * N
        messages.extend(followups)

        if early_complete:
            break

    loop_elapsed = time.time() - loop_t0

    if llm_error is not None:
        test_summary = f"Outer LLM call failed: {llm_error}"
        test_log(
            "warn",
            "executor_loop_exit_llm_error",
            template_name=tpl_name,
            err=llm_error,
        )
    elif not completed:
        test_summary = f"Test execution hit the iteration limit ({max_iterations}). The test flow may be incomplete."
        test_log(
            "warn",
            "executor_loop_exit_iteration_limit",
            template_name=tpl_name,
            max_iterations=max_iterations,
        )

    test_log(
        "info",
        "executor_template_ok",
        template_name=tpl_name,
        elapsed_s=round(loop_elapsed, 3),
        iterations_used=iterations_used,
        max_iterations=max_iterations,
        passed=test_passed,
        completed=completed,
        action_count=len(actions),
        screenshot_count=len(screenshots),
        bug_count=len(bugs_found),
        credentials_saved=credentials_saved,
    )

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
