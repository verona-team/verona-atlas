"""
Test planner that uses Claude to select and prioritize test templates
based on recent GitHub commits, PostHog sessions, Sentry issues,
LangSmith traces, and Braintrust evaluation data.
"""
import os
import json
from typing import Any

from anthropic import Anthropic
from runner.integrations import (
    fetch_recent_commits,
    fetch_posthog_sessions,
    fetch_posthog_errors,
    fetch_sentry_issues,
    fetch_langsmith_errors,
    fetch_braintrust_errors,
)
from runner.encryption import decrypt


async def plan_tests(
    project: dict,
    integrations: dict[str, dict],
    templates: list[dict],
) -> list[dict]:
    """Use Claude to prioritize which templates to run and in what order."""

    if not templates:
        return []

    commits: list = []
    sessions: list = []
    posthog_errors: list = []
    sentry_issues: list = []
    langsmith_errs: list = []
    braintrust_errs: list = []

    github_integration = integrations.get("github")
    if github_integration:
        config = github_integration.get("config", {})
        try:
            commits = await fetch_recent_commits(config)
        except Exception as e:
            print(f"Warning: Failed to fetch GitHub commits: {e}")

    posthog_integration = integrations.get("posthog")
    if posthog_integration:
        config = posthog_integration.get("config", {})
        try:
            sessions = await fetch_posthog_sessions(config)
        except Exception as e:
            print(f"Warning: Failed to fetch PostHog sessions: {e}")
        try:
            posthog_errors = await fetch_posthog_errors(config)
        except Exception as e:
            print(f"Warning: Failed to fetch PostHog errors: {e}")

    sentry_integration = integrations.get("sentry")
    if sentry_integration:
        config = sentry_integration.get("config", {})
        try:
            sentry_issues = await fetch_sentry_issues(config)
        except Exception as e:
            print(f"Warning: Failed to fetch Sentry issues: {e}")

    langsmith_integration = integrations.get("langsmith")
    if langsmith_integration:
        config = langsmith_integration.get("config", {})
        try:
            langsmith_errs = await fetch_langsmith_errors(config)
        except Exception as e:
            print(f"Warning: Failed to fetch LangSmith errors: {e}")

    braintrust_integration = integrations.get("braintrust")
    if braintrust_integration:
        config = braintrust_integration.get("config", {})
        try:
            braintrust_errs = await fetch_braintrust_errors(config)
        except Exception as e:
            print(f"Warning: Failed to fetch Braintrust errors: {e}")

    has_context = any([
        commits, sessions, posthog_errors,
        sentry_issues, langsmith_errs, braintrust_errs,
    ])
    if not has_context:
        return templates

    client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    template_summaries = [
        {"id": t["id"], "name": t["name"], "description": t.get("description", ""), "steps_count": len(t.get("steps", []))}
        for t in templates
    ]

    context_sections = []
    if commits:
        context_sections.append(f"Recent Git Commits:\n{json.dumps(commits[:15], indent=2, default=str)}")
    if sessions:
        context_sections.append(f"Recent PostHog Sessions:\n{json.dumps(sessions[:10], indent=2, default=str)}")
    if posthog_errors:
        context_sections.append(f"PostHog Error Events:\n{json.dumps(posthog_errors[:10], indent=2, default=str)}")
    if sentry_issues:
        context_sections.append(f"Sentry Issues (unresolved):\n{json.dumps(sentry_issues[:10], indent=2, default=str)}")
    if langsmith_errs:
        context_sections.append(f"LangSmith Failed LLM Runs:\n{json.dumps(langsmith_errs[:10], indent=2, default=str)}")
    if braintrust_errs:
        context_sections.append(f"Braintrust Evaluation Failures:\n{json.dumps(braintrust_errs[:10], indent=2, default=str)}")

    context_block = "\n\n".join(context_sections)

    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": f"""You are a QA test planner. Given the following context about recent code changes, user behavior, and errors, prioritize which test templates to run.

{context_block}

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

        id_to_template = {t["id"]: t for t in templates}
        ordered = []
        for tid in priority_ids:
            if tid in id_to_template:
                ordered.append(id_to_template.pop(tid))
        ordered.extend(id_to_template.values())
        return ordered
    except (json.JSONDecodeError, KeyError):
        return templates
