"""
Test run reporter — aggregates results and sends Slack notifications
enriched with observability data from Sentry, LangSmith, Braintrust, and PostHog.
"""
import os
import json
from typing import Any

import httpx
from anthropic import Anthropic
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


async def generate_ai_summary(
    project: dict,
    results: list[dict],
    summary: dict,
    observability_data: dict[str, list[dict]] | None = None,
) -> str:
    """Use Claude to generate an executive summary of the test run."""
    try:
        client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

        obs_section = ""
        if observability_data:
            obs_parts = []
            if observability_data.get("sentry_events"):
                obs_parts.append(f"Sentry Errors ({len(observability_data['sentry_events'])}):\n{json.dumps(observability_data['sentry_events'][:5], indent=2, default=str)}")
            if observability_data.get("posthog_errors"):
                obs_parts.append(f"PostHog Exceptions ({len(observability_data['posthog_errors'])}):\n{json.dumps(observability_data['posthog_errors'][:5], indent=2, default=str)}")
            if observability_data.get("langsmith_errors"):
                obs_parts.append(f"LangSmith Failed LLM Runs ({len(observability_data['langsmith_errors'])}):\n{json.dumps(observability_data['langsmith_errors'][:5], indent=2, default=str)}")
            if observability_data.get("braintrust_errors"):
                obs_parts.append(f"Braintrust Evaluation Failures ({len(observability_data['braintrust_errors'])}):\n{json.dumps(observability_data['braintrust_errors'][:5], indent=2, default=str)}")
            if obs_parts:
                obs_section = "\n\nObservability Errors Detected During Test Run:\n" + "\n\n".join(obs_parts)

        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": f"""Analyze this QA test run for the web application at {project.get('app_url', 'unknown')}.

Test Results Summary:
- Total: {summary.get('total', 0)}
- Passed: {summary.get('passed', 0)}
- Failed: {summary.get('failed', 0)}
- Errors: {summary.get('errors', 0)}

Individual Results:
{json.dumps(results, indent=2, default=str)}{obs_section}

Provide a concise summary including:
1. Executive summary (1-2 sentences)
2. Any bugs found with reproduction steps
3. Observability errors detected (Sentry, PostHog, LangSmith, Braintrust) and their severity
4. Recommended fixes (if failures detected)
5. Severity assessment for each issue
Keep it under 500 words."""
            }],
        )

        content = message.content[0]
        return content.text if content.type == "text" else ""
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
    app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "https://atlas.app")
    dashboard_url = f"{app_url}/projects/{project['id']}/runs/{test_run_id}"

    failed_count = summary.get("failed", 0) + summary.get("errors", 0)
    has_obs_errors = bool(observability_data and any(observability_data.values()))
    status_emoji = "✅" if failed_count == 0 and not has_obs_errors else "⚠️"
    status_text = "All Passed" if failed_count == 0 and not has_obs_errors else "Failures Detected"

    blocks: list[dict] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"{status_emoji} Atlas Test Run — {project['name']}"},
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
        failed_text = "*Failed Tests:*\n"
        for t in failed_tests[:5]:
            name = t.get("test_template_id", "Unknown")[:20]
            error = (t.get("error_message") or "Unknown error")[:100]
            failed_text += f"• {name}: {error}\n"
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": failed_text}})

    if observability_data:
        sentry_events = observability_data.get("sentry_events", [])
        if sentry_events:
            blocks.append({"type": "divider"})
            sentry_text = f"*🔴 Sentry Errors ({len(sentry_events)}):*\n"
            for err in sentry_events[:5]:
                title = err.get("title", "Unknown error")[:80]
                level = err.get("level", "error")
                sentry_text += f"• *{title}* ({level})\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": sentry_text}})

        posthog_errors = observability_data.get("posthog_errors", [])
        if posthog_errors:
            blocks.append({"type": "divider"})
            ph_text = f"*🟠 PostHog Exceptions ({len(posthog_errors)}):*\n"
            for err in posthog_errors[:5]:
                props = err.get("properties", err)
                exc_type = props.get("exception_type", "Unknown")
                exc_msg = str(props.get("exception_message", ""))[:80]
                url = props.get("url", "")
                ph_text += f"• *{exc_type}*: {exc_msg}"
                if url:
                    ph_text += f" — {url}"
                ph_text += "\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": ph_text}})

        llm_errors = (
            observability_data.get("langsmith_errors", [])
            + observability_data.get("braintrust_errors", [])
        )
        if llm_errors:
            blocks.append({"type": "divider"})
            llm_text = f"*🤖 LLM Trace Failures ({len(llm_errors)}):*\n"
            for err in llm_errors[:5]:
                name = err.get("name", "Unknown")[:40]
                error_msg = str(err.get("error", "Failed"))[:80]
                llm_text += f"• *{name}*: {error_msg}\n"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": llm_text}})

    if ai_summary:
        blocks.append({"type": "divider"})
        truncated = ai_summary[:2900]
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*AI Analysis:*\n{truncated}"}})

    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"<{dashboard_url}|View full report in Atlas →>"},
    })

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
                "text": f"Atlas Test Run — {project['name']}: {status_text}",
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
