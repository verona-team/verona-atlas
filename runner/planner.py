"""
Test planner that uses Claude to select and prioritize test templates
based on recent GitHub commits and PostHog session data.
"""
import os
import json
from typing import Any

from anthropic import Anthropic
from runner.integrations import fetch_recent_commits, fetch_posthog_sessions, fetch_posthog_errors
from runner.encryption import decrypt


async def plan_tests(
    project: dict,
    integrations: dict[str, dict],
    templates: list[dict],
) -> list[dict]:
    """Use Claude to prioritize which templates to run and in what order."""
    
    if not templates:
        return []
    
    # Gather context
    commits = []
    sessions = []
    errors = []
    
    # Fetch GitHub data if connected
    github_integration = integrations.get("github")
    if github_integration:
        config = github_integration.get("config", {})
        try:
            commits = await fetch_recent_commits(config)
        except Exception as e:
            print(f"Warning: Failed to fetch GitHub commits: {e}")
    
    # Fetch PostHog data if connected
    posthog_integration = integrations.get("posthog")
    if posthog_integration:
        config = posthog_integration.get("config", {})
        try:
            sessions = await fetch_posthog_sessions(config)
        except Exception as e:
            print(f"Warning: Failed to fetch PostHog sessions: {e}")
        try:
            errors = await fetch_posthog_errors(config)
        except Exception as e:
            print(f"Warning: Failed to fetch PostHog errors: {e}")
    
    # If no integrations, just return all templates in order
    if not commits and not sessions and not errors:
        return templates
    
    # Use Claude to prioritize
    client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    
    template_summaries = [
        {"id": t["id"], "name": t["name"], "description": t.get("description", ""), "steps_count": len(t.get("steps", []))}
        for t in templates
    ]
    
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": f"""You are a QA test planner. Given the following context, prioritize which test templates to run.

Recent Git Commits:
{json.dumps(commits[:15], indent=2, default=str)}

Recent PostHog Sessions (user behavior):
{json.dumps(sessions[:10], indent=2, default=str)}

Error Events:
{json.dumps(errors[:10], indent=2, default=str)}

Available Test Templates:
{json.dumps(template_summaries, indent=2)}

Return a JSON array of template IDs in priority order (highest priority first).
Include ALL template IDs. Return ONLY the JSON array, no explanation.
Example: ["id1", "id2", "id3"]"""
        }],
    )
    
    content = message.content[0]
    if content.type != "text":
        return templates
    
    try:
        text = content.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0]
        
        priority_ids = json.loads(text)
        
        # Reorder templates by priority
        id_to_template = {t["id"]: t for t in templates}
        ordered = []
        for tid in priority_ids:
            if tid in id_to_template:
                ordered.append(id_to_template.pop(tid))
        # Add any remaining templates
        ordered.extend(id_to_template.values())
        return ordered
    except (json.JSONDecodeError, KeyError):
        return templates
