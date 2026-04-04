"""
Stagehand v3 + Browserbase + Playwright session management.

The Stagehand Python SDK v3 is a pure API client (BYOB — Bring Your Own Browser).
We create a Stagehand session to get a Browserbase session ID, then connect
Playwright to that session over CDP for direct page interaction.
"""
import os
from typing import Any

from stagehand import AsyncStagehand
from playwright.async_api import async_playwright


STAGEHAND_SESSION_MODEL = "anthropic/claude-sonnet-4-6"


async def create_stagehand_session() -> dict[str, Any]:
    """Create a Stagehand session backed by a Browserbase cloud browser.

    Returns a dict with:
      - client:     AsyncStagehand API client
      - session:    AsyncSession bound to the Browserbase session
      - session_id: Browserbase session ID (for recordings)
      - playwright: Playwright instance (must be stopped on cleanup)
      - browser:    Playwright Browser connected over CDP
      - page:       Playwright Page ready for interaction
    """
    bb_api_key = os.environ["BROWSERBASE_API_KEY"]
    bb_project_id = os.environ["BROWSERBASE_PROJECT_ID"]
    model_api_key = os.environ.get("MODEL_API_KEY", os.environ.get("ANTHROPIC_API_KEY", ""))

    client = AsyncStagehand(
        browserbase_api_key=bb_api_key,
        browserbase_project_id=bb_project_id,
        model_api_key=model_api_key,
    )

    session = await client.sessions.start(model_name=STAGEHAND_SESSION_MODEL)
    session_id = session.id

    pw = await async_playwright().start()
    cdp_url = f"wss://connect.browserbase.com?apiKey={bb_api_key}&sessionId={session_id}"
    browser = await pw.chromium.connect_over_cdp(cdp_url)
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else await context.new_page()

    return {
        "client": client,
        "session": session,
        "session_id": session_id,
        "playwright": pw,
        "browser": browser,
        "page": page,
    }


async def cleanup_session(
    client: AsyncStagehand,
    session: Any,
    browser: Any,
    playwright_inst: Any,
) -> None:
    """Tear down Playwright + Stagehand session resources."""
    try:
        await browser.close()
    except Exception:
        pass
    try:
        await playwright_inst.stop()
    except Exception:
        pass
    try:
        await session.end()
    except Exception:
        pass
    try:
        await client.close()
    except Exception:
        pass
