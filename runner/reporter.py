"""
Test run reporter — aggregates results and sends Slack notifications
enriched with observability data from Sentry, LangSmith, Braintrust, and PostHog.
"""
import json
from typing import Any

import httpx
from runner.chat.models import get_gemini_flash
from runner.encryption import decrypt
from runner.logging import test_log


async def send_report(
    supabase,
    project: dict,
    integrations: dict[str, dict],
    test_run_id: str,
    results: list[dict],
    summary: dict,
):
    """Generate AI analysis and send Slack report."""

    test_log(
        "info",
        "reporter_send_report_begin",
        test_run_id=test_run_id,
        project_id=project.get("id"),
        result_count=len(results),
        has_slack=bool(integrations.get("slack")),
    )

    observability_data = _aggregate_observability(results)

    ai_summary = await generate_ai_summary(project, results, summary, observability_data)

    if ai_summary:
        current_summary = {**summary, "ai_analysis": ai_summary}
        if observability_data:
            current_summary["observability"] = _summarize_observability_counts(observability_data)
        supabase.table("test_runs").update({"summary": current_summary}).eq("id", test_run_id).execute()

    slack_integration = integrations.get("slack")
    if slack_integration:
        config = slack_integration.get("config", {})
        bot_token_encrypted = config.get("bot_token_encrypted")
        channel_id = config.get("channel_id")

        if bot_token_encrypted and channel_id:
            bot_token = decrypt(bot_token_encrypted)
            await send_slack_report(
                bot_token, channel_id, project, test_run_id,
                results, summary, ai_summary, observability_data,
            )


def _aggregate_observability(results: list[dict]) -> dict[str, list[dict]]:
    """Collect observability errors from all test result console_logs."""
    aggregated: dict[str, list[dict]] = {}
    seen_ids: dict[str, set[str]] = {}

    for result in results:
        console_logs = result.get("console_logs") or {}
        obs = console_logs.get("observability") or {}
        for key, items in obs.items():
            if key not in aggregated:
                aggregated[key] = []
                seen_ids[key] = set()
            for item in items:
                item_id = str(item.get("id", item.get("event_id", item.get("title", ""))))
                if item_id and item_id not in seen_ids[key]:
                    seen_ids[key].add(item_id)
                    aggregated[key].append(item)

    return aggregated


def _summarize_observability_counts(data: dict[str, list[dict]]) -> dict[str, int]:
    """Return counts per observability source for storing in summary."""
    return {key: len(items) for key, items in data.items() if items}


def _compact_results_for_summary(results: list[dict]) -> list[dict]:
    """Strip heavy fields so the model stays brief; full data is already in Slack blocks."""
    out: list[dict] = []
    for r in results:
        err_raw = str(r.get("error_message") or "").strip()
        out.append(
            {
                "template_id": r.get("test_template_id"),
                "status": r.get("status"),
                "error": (err_raw[:240] if err_raw else None),
            }
        )
    return out


async def generate_ai_summary(
    project: dict,
    results: list[dict],
    summary: dict,
    observability_data: dict[str, list[dict]] | None = None,
) -> str:
    """Use Gemini 3 Flash to generate a short executive blurb for the test run."""
    try:
        obs_section = ""
        if observability_data:
            obs_parts = []
            if observability_data.get("sentry_events"):
                obs_parts.append(
                    f"Sentry ({len(observability_data['sentry_events'])}): "
                    f"{json.dumps(observability_data['sentry_events'][:2], default=str)}"
                )
            if observability_data.get("posthog_errors"):
                obs_parts.append(
                    f"PostHog ({len(observability_data['posthog_errors'])}): "
                    f"{json.dumps(observability_data['posthog_errors'][:2], default=str)}"
                )
            if observability_data.get("langsmith_errors"):
                obs_parts.append(
                    f"LangSmith ({len(observability_data['langsmith_errors'])}): "
                    f"{json.dumps(observability_data['langsmith_errors'][:2], default=str)}"
                )
            if observability_data.get("braintrust_errors"):
                obs_parts.append(
                    f"Braintrust ({len(observability_data['braintrust_errors'])}): "
                    f"{json.dumps(observability_data['braintrust_errors'][:2], default=str)}"
                )
            if obs_parts:
                obs_section = "\nObservability (samples):\n" + "\n".join(obs_parts)

        compact = _compact_results_for_summary(results)
        prompt = f"""You write Slack-friendly QA run blurbs. App: {project.get('app_url', 'unknown')}.

Counts: passed {summary.get('passed', 0)}, failed {summary.get('failed', 0)}, errors {summary.get('errors', 0)}, total {summary.get('total', 0)}.

Per-template: {json.dumps(compact, default=str)}{obs_section}

Rules:
- Maximum 80 words. Plain text, no markdown headings, no numbered lists longer than 3 short bullets.
- One line: overall pass/fail verdict.
- If anything failed: one line on the worst issue (template id + cause). Skip reproduction steps.
- If observability samples exist: one short phrase only (e.g. "Sentry: N errors seen during run").
- If all passed and no observability issues: say so in one sentence. No filler."""

        # No max_tokens override: the prompt asks for "under 500 words" but
        # Gemini 3 Flash burns output tokens on reasoning BEFORE emitting
        # the visible summary, and a tight cap silently truncated the
        # Slack AI-analysis block. Prompt enforces length; the helper
        # default (66k, the model's ceiling) is the safe token cap.
        model = get_gemini_flash()
        response = await model.ainvoke(prompt)

        # Gemini 3 returns list content blocks (one per thought-signed text
        # span). Prefer `.text` (LangChain's accessor that flattens blocks
        # to the concatenated text); fall back to manual block traversal
        # for older LangChain versions that only expose `.content`.
        text = getattr(response, "text", None)
        if isinstance(text, str) and text.strip():
            return text.strip()

        content = response.content
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    t = block.get("text")
                    if isinstance(t, str):
                        parts.append(t)
                elif isinstance(block, str):
                    parts.append(block)
            return "".join(parts).strip()
        return ""
    except Exception as e:
        test_log(
            "warn",
            "reporter_ai_summary_failed",
            err_type=type(e).__name__,
            err=str(e),
        )
        return ""


async def send_slack_report(
    bot_token: str,
    channel_id: str,
    project: dict,
    test_run_id: str,
    results: list[dict],
    summary: dict,
    ai_summary: str,
    observability_data: dict[str, list[dict]] | None = None,
):
    """Format and send Slack Block Kit message with observability enrichment."""
    failed_count = summary.get("failed", 0) + summary.get("errors", 0)
    has_obs_errors = bool(observability_data and any(observability_data.values()))
    status_emoji = "✅" if failed_count == 0 and not has_obs_errors else "⚠️"
    status_text = "All Passed" if failed_count == 0 and not has_obs_errors else "Failures Detected"

    blocks: list[dict] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{status_emoji} Test run — {project['name']}"},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Status:* {status_text}"},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Passed:* {summary.get('passed', 0)}"},
                {"type": "mrkdwn", "text": f"*Failed:* {summary.get('failed', 0)}"},
                {"type": "mrkdwn", "text": f"*Errors:* {summary.get('errors', 0)}"},
                {"type": "mrkdwn", "text": f"*Total:* {summary.get('total', 0)}"},
            ],
        },
    ]

    failed_tests = [r for r in results if r.get("status") in ("failed", "error")]
    if failed_tests:
        blocks.append({"type": "divider"})
        failed_text = "*Failed:*\n"
        for t in failed_tests[:3]:
            name = str(t.get("test_template_id", "Unknown"))[:24]
            error = (t.get("error_message") or "Unknown error")[:72]
            failed_text += f"• `{name}` — {error}\n"
        if len(failed_tests) > 3:
            failed_text += f"_…+{len(failed_tests) - 3} more_\n"
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": failed_text}})

    if observability_data:
        sentry_events = observability_data.get("sentry_events", [])
        if sentry_events:
            blocks.append({"type": "divider"})
            sentry_text = f"*Sentry ({len(sentry_events)}):*\n"
            for err in sentry_events[:3]:
                title = err.get("title", "Unknown error")[:60]
                level = err.get("level", "error")
                sentry_text += f"• *{title}* ({level})\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": sentry_text}})

        posthog_errors = observability_data.get("posthog_errors", [])
        if posthog_errors:
            blocks.append({"type": "divider"})
            ph_text = f"*PostHog ({len(posthog_errors)}):*\n"
            for err in posthog_errors[:3]:
                props = err.get("properties", err)
                exc_type = props.get("exception_type", "Unknown")
                exc_msg = str(props.get("exception_message", ""))[:60]
                ph_text += f"• *{exc_type}*: {exc_msg}\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": ph_text}})

        llm_errors = (
            observability_data.get("langsmith_errors", [])
            + observability_data.get("braintrust_errors", [])
        )
        if llm_errors:
            blocks.append({"type": "divider"})
            llm_text = f"*LLM traces ({len(llm_errors)}):*\n"
            for err in llm_errors[:3]:
                name = err.get("name", "Unknown")[:32]
                error_msg = str(err.get("error", "Failed"))[:60]
                llm_text += f"• *{name}*: {error_msg}\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": llm_text}})

    if ai_summary:
        blocks.append({"type": "divider"})
        truncated = ai_summary[:900]
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*Summary:*\n{truncated}"}})

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": f"Bearer {bot_token}",
                "Content-Type": "application/json",
            },
            json={
                "channel": channel_id,
                "blocks": blocks,
                "text": (
                    f"Test run — {project['name']}: {status_text} "
                    f"({test_run_id[:8]}…)"
                ),
            },
        )
        data = response.json()
        if not data.get("ok"):
            test_log(
                "warn",
                "reporter_slack_post_failed",
                slack_error=data.get("error"),
                status_code=response.status_code,
            )
        else:
            test_log(
                "info",
                "reporter_slack_post_ok",
                channel_id=channel_id,
            )
