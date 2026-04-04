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
from datetime import datetime, timezone
from typing import Any

from anthropic import Anthropic

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
        print(f"Warning: screenshot capture failed: {e}")

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

    try:
        result = await session.execute(
            execute_options={
                "instruction": instruction,
                "max_steps": 10,
            },
            agent_config={
                "model": STAGEHAND_AGENT_MODEL,
            },
            timeout=120.0,
        )
        if result is not None:
            if hasattr(result, "data") and hasattr(result.data, "result"):
                agent_output = result.data.result.message
            else:
                agent_output = str(result)
    except Exception as e:
        success = False
        error = str(e)

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
    try:
        response = await session.observe(instruction=query)
        results = response.data.result if hasattr(response, "data") else []
        found = results is not None and len(results) > 0
        return {
            "found": found,
            "observations": str([r.to_dict() for r in results]) if results else "No matching elements found.",
        }
    except Exception as e:
        return {
            "found": False,
            "observations": f"Observation failed: {e}",
        }


def _strip_images_from_message(msg: dict) -> dict:
    """Return a copy of *msg* with image blocks replaced by text placeholders.

    This preserves the message structure (and therefore role alternation)
    while reducing the token cost of older turns that no longer need
    full-resolution screenshots.
    """
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
    """Strip screenshot images from older messages to manage context size.

    Messages are never removed or reordered — only image data in older
    turns is replaced with a text placeholder.  This keeps the full
    conversation history for reasoning while staying within the context
    window.
    """
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
) -> dict:
    """Execute a test template using the agentic ReAct loop.

    Args:
        session: Stagehand v3 AsyncSession (for AI-powered act/observe/execute)
        page: Playwright Page (for screenshots and direct navigation)
        template: Test template dict from DB
        project: Project dict from DB
        integrations: Integration configs

    Returns a rich result dict containing:
      - passed: bool
      - summary: str
      - bugs_found: list[dict]
      - actions: list[dict]          (full trace of every action taken)
      - screenshot_urls: list[str]   (populated later by caller uploading to storage)
      - screenshots: list[dict]      (raw screenshot data for upload)
    """
    steps = template.get("steps", [])
    if isinstance(steps, str):
        steps = json.loads(steps)
    steps = sorted(steps, key=lambda s: s.get("order", 0))

    max_iterations = max(len(steps) * 10, 10)

    anthropic = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    system_prompt = build_system_prompt(template, project, integrations)

    initial_state = await capture_page_state(page)

    initial_content: list[dict] = [
        {"type": "text", "text": (
            f"The browser is open and ready. Current URL: {initial_state['url']}\n"
            "Here is a screenshot of the current page state. "
            "Review the test plan in your system prompt and begin executing the test flow."
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
    iterations_used = 0

    if initial_state["screenshot_base64"]:
        screenshots.append({
            "label": "initial_state",
            "base64": initial_state["screenshot_base64"],
            "url": initial_state["url"],
            "timestamp": initial_state["timestamp"],
        })

    for iteration in range(max_iterations):
        iterations_used = iteration + 1
        messages = _compress_messages(messages, keep_recent_images=12)

        try:
            response = anthropic.messages.create(
                model=OUTER_AGENT_MODEL,
                system=system_prompt,
                tools=TOOLS,
                messages=messages,
            )
        except Exception as e:
            print(f"Error: outer agent LLM call failed on iteration {iteration}: {e}")
            actions.append({
                "iteration": iteration,
                "tool": "llm_error",
                "error": str(e),
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
            completed = True
            break

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        if not tool_use_blocks:
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
                print(f"  [iter {iteration}] browser_action: {instruction[:100]}")

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
                print(f"  [iter {iteration}] observe_dom: {query[:100]}")

                result = await execute_observe_dom(session, query)
                action_record["found"] = result["found"]
                action_record["observations"] = result["observations"][:500]

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result["observations"],
                })

            elif tool_name == "complete_test":
                test_passed = tool_input.get("passed", False)
                test_summary = tool_input.get("summary", "")
                bugs_found = tool_input.get("bugs_found", [])

                print(f"  [iter {iteration}] complete_test: passed={test_passed}")

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

    if not completed:
        test_summary = f"Test execution hit the iteration limit ({max_iterations}). The test flow may be incomplete."

    return {
        "passed": test_passed,
        "summary": test_summary,
        "bugs_found": bugs_found,
        "actions": actions,
        "screenshots": screenshots,
        "iterations_used": iterations_used,
        "max_iterations": max_iterations,
        "hit_iteration_limit": not completed,
    }
