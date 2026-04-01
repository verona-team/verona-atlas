"""
Unified observability data collector.
Pulls real-time data from all connected observability platforms
before and after test execution to detect errors introduced during tests.
"""
import asyncio
from typing import Any

from runner.integrations import (
    fetch_posthog_realtime_errors,
    fetch_sentry_realtime_events,
    fetch_langsmith_traces,
    fetch_langsmith_errors,
    fetch_braintrust_logs,
    fetch_braintrust_errors,
)


async def collect_observability_data(
    integrations: dict[str, dict],
    window_minutes: int = 5,
) -> dict[str, list[dict]]:
    """
    Pull real-time data from all connected observability platforms.
    Called before and after each test template execution.
    """
    tasks: dict[str, Any] = {}

    posthog = integrations.get("posthog")
    if posthog:
        config = posthog.get("config", {})
        tasks["posthog_errors"] = fetch_posthog_realtime_errors(config, window_minutes)

    sentry = integrations.get("sentry")
    if sentry:
        config = sentry.get("config", {})
        tasks["sentry_events"] = fetch_sentry_realtime_events(config, window_minutes)

    langsmith = integrations.get("langsmith")
    if langsmith:
        config = langsmith.get("config", {})
        tasks["langsmith_traces"] = fetch_langsmith_traces(config, window_minutes)
        tasks["langsmith_errors"] = fetch_langsmith_errors(config, window_minutes)

    braintrust = integrations.get("braintrust")
    if braintrust:
        config = braintrust.get("config", {})
        tasks["braintrust_logs"] = fetch_braintrust_logs(config, window_minutes)
        tasks["braintrust_errors"] = fetch_braintrust_errors(config, window_minutes)

    if not tasks:
        return {}

    keys = list(tasks.keys())
    coros = list(tasks.values())
    results = await asyncio.gather(*coros, return_exceptions=True)

    data: dict[str, list[dict]] = {}
    for key, result in zip(keys, results):
        if isinstance(result, Exception):
            print(f"Warning: observability fetch failed for {key}: {result}")
            data[key] = []
        else:
            data[key] = result

    return data


def diff_observability_snapshots(
    pre: dict[str, list[dict]],
    post: dict[str, list[dict]],
) -> dict[str, list[dict]]:
    """
    Compare pre-test and post-test observability snapshots.
    Returns only entries that appeared in the post snapshot but not in pre.
    """
    new_errors: dict[str, list[dict]] = {}

    all_keys = set(list(pre.keys()) + list(post.keys()))
    for key in all_keys:
        pre_items = pre.get(key, [])
        post_items = post.get(key, [])

        pre_ids = _extract_ids(pre_items)

        new_items = []
        for item in post_items:
            item_id = _get_item_id(item)
            if item_id and item_id not in pre_ids:
                new_items.append(item)
            elif not item_id:
                if item not in pre_items:
                    new_items.append(item)

        if new_items:
            new_errors[key] = new_items

    return new_errors


def _extract_ids(items: list[dict]) -> set[str]:
    """Extract unique identifiers from observability items."""
    ids: set[str] = set()
    for item in items:
        item_id = _get_item_id(item)
        if item_id:
            ids.add(item_id)
    return ids


def _get_item_id(item: dict) -> str | None:
    """Get the best available unique identifier for an observability item."""
    for id_field in ("id", "event_id", "eventID", "sha"):
        val = item.get(id_field)
        if val:
            return str(val)

    ts = item.get("timestamp", item.get("start_time", item.get("created", "")))
    title = item.get("title", item.get("name", item.get("message", "")))
    if ts and title:
        return f"{ts}:{title}"

    return None
