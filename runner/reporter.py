"""
Test run reporter — aggregates results and sends Slack notifications.
"""
import os
import json
from typing import Any

import httpx
from anthropic import Anthropic
from runner.encryption import decrypt


async def send_report(
    supabase,
    project: dict,
    integrations: dict[str, dict],
    test_run_id: str,
    results: list[dict],
    summary: dict,
):
    """Generate AI analysis and send Slack report."""
    
    # Generate AI analysis
    ai_summary = await generate_ai_summary(project, results, summary)
    
    # Update test run with AI summary
    if ai_summary:
        current_summary = {**summary, "ai_analysis": ai_summary}
        supabase.table("test_runs").update({"summary": current_summary}).eq("id", test_run_id).execute()
    
    # Send Slack report if connected
    slack_integration = integrations.get("slack")
    if slack_integration:
        config = slack_integration.get("config", {})
        bot_token_encrypted = config.get("bot_token_encrypted")
        channel_id = config.get("channel_id")
        
        if bot_token_encrypted and channel_id:
            bot_token = decrypt(bot_token_encrypted)
            await send_slack_report(
                bot_token, channel_id, project, test_run_id, results, summary, ai_summary
            )


async def generate_ai_summary(project: dict, results: list[dict], summary: dict) -> str:
    """Use Claude to generate an executive summary of the test run."""
    try:
        client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        
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
{json.dumps(results, indent=2, default=str)}

Provide a concise summary including:
1. Executive summary (1-2 sentences)
2. Any bugs found with reproduction steps
3. Recommended fixes (if failures detected)
4. Severity assessment for each issue
Keep it under 500 words."""
            }],
        )
        
        content = message.content[0]
        return content.text if content.type == "text" else ""
    except Exception as e:
        print(f"Warning: Failed to generate AI summary: {e}")
        return ""


async def send_slack_report(
    bot_token: str,
    channel_id: str,
    project: dict,
    test_run_id: str,
    results: list[dict],
    summary: dict,
    ai_summary: str,
):
    """Format and send Slack Block Kit message."""
    app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "https://atlas.app")
    dashboard_url = f"{app_url}/projects/{project['id']}/runs/{test_run_id}"
    
    failed_count = summary.get("failed", 0) + summary.get("errors", 0)
    status_emoji = "✅" if failed_count == 0 else "⚠️"
    status_text = "All Passed" if failed_count == 0 else "Failures Detected"
    
    blocks = [
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
    
    # Add failed test details
    failed_tests = [r for r in results if r.get("status") in ("failed", "error")]
    if failed_tests:
        blocks.append({"type": "divider"})
        failed_text = "*Failed Tests:*\n"
        for t in failed_tests[:5]:
            name = t.get("test_template_id", "Unknown")[:20]
            error = (t.get("error_message") or "Unknown error")[:100]
            failed_text += f"• {name}: {error}\n"
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": failed_text}})
    
    # AI Summary
    if ai_summary:
        blocks.append({"type": "divider"})
        # Truncate for Slack's 3000 char block limit
        truncated = ai_summary[:2900]
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*AI Analysis:*\n{truncated}"}})
    
    # Dashboard link
    blocks.append({"type": "divider"})
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"<{dashboard_url}|View full report in Atlas →>"},
    })
    
    # Send message
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
            print(f"Warning: Slack message failed: {data.get('error')}")
