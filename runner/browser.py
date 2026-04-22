"""
Stagehand v3 + Browserbase + Playwright session management.

The Stagehand Python SDK v3 is a pure API client (BYOB — Bring Your Own Browser).
We create a Stagehand session to get a Browserbase session ID, then connect
Playwright to that session over CDP for direct page interaction.

Migration reference: https://docs.stagehand.dev/v3/migrations/python
"""
import os
import time
from typing import Any

import httpx
from stagehand import AsyncStagehand
from playwright.async_api import async_playwright

from runner.prompts import STAGEHAND_SESSION_MODEL


def _strip_provider_prefix(model: str) -> tuple[str, str]:
    """Split ``'provider/model-id'`` → ``(provider, model-id)``.

    If no ``/`` is present, defaults to ``("anthropic", model)``.
    """
    if "/" in model:
        provider, _, bare = model.partition("/")
        return provider, bare
    return "anthropic", model


def stagehand_agent_model_config(
    model_name: str | None = None,
    *,
    prefixed: bool = False,
) -> dict[str, str]:
    """Model config for Stagehand ``agent_config.model`` and ``observe`` ``options.model`` (ModelConfigParam).

    Uses snake_case keys per the Stagehand Python SDK; they serialize to
    ``modelName`` / ``apiKey`` / ``provider`` in the JSON body.

    The ``execute`` (agentExecute) endpoint requires the **bare** model id
    (e.g. ``claude-opus-4-6``) with the provider supplied separately —
    passing the prefixed form caused a 404 because the server forwarded it
    verbatim to the provider API.

    The ``observe`` endpoint, conversely, expects ``model_name`` in
    ``provider/model`` format (e.g. ``anthropic/claude-opus-4-6``) and
    returns an ``UnsupportedModelError`` if only the bare id is given.

    Set *prefixed* to ``True`` when building config for ``observe`` calls.
    """
    key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise ValueError("ANTHROPIC_API_KEY is required for Stagehand agent/observe model config")
    raw = model_name or STAGEHAND_SESSION_MODEL
    provider, bare_model = _strip_provider_prefix(raw)
    if prefixed:
        return {
            "model_name": f"{provider}/{bare_model}",
            "api_key": key,
        }
    return {
        "provider": provider,
        "model_name": bare_model,
        "api_key": key,
    }


def _resolve_anthropic_key_for_stagehand_client() -> tuple[str, str]:
    """Read ANTHROPIC_API_KEY for Stagehand (same secret as the outer QA agent)."""
    v = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    return (v, "ANTHROPIC_API_KEY") if v else ("", "none")


async def create_stagehand_session() -> dict[str, Any]:
    """Create a Stagehand session backed by a Browserbase cloud browser.

    On partial failure (e.g. Playwright CDP connection fails after the
    Browserbase session is already running), all previously-allocated
    resources are torn down before re-raising so we never leak a paid
    cloud browser session.

    Returns a dict with:
      - client:     AsyncStagehand API client
      - session:    AsyncSession bound to the Browserbase session
      - session_id: Browserbase session ID (for recordings)
      - playwright: Playwright instance (must be stopped on cleanup)
      - browser:    Playwright Browser connected over CDP
      - page:       Playwright Page ready for interaction
    """
    t0 = time.time()
    print("[BROWSER] create_stagehand_session — starting")

    bb_api_key = os.environ.get("BROWSERBASE_API_KEY", "")
    bb_project_id = os.environ.get("BROWSERBASE_PROJECT_ID", "")
    anthropic_api_key, anthropic_key_source = _resolve_anthropic_key_for_stagehand_client()

    if not bb_api_key:
        print("[BROWSER] ERROR: BROWSERBASE_API_KEY is missing or empty")
        raise ValueError("BROWSERBASE_API_KEY environment variable is required")
    if not bb_project_id:
        print("[BROWSER] ERROR: BROWSERBASE_PROJECT_ID is missing or empty")
        raise ValueError("BROWSERBASE_PROJECT_ID environment variable is required")
    if not anthropic_api_key:
        print("[BROWSER] ERROR: ANTHROPIC_API_KEY missing or empty (required for Stagehand and the outer QA agent)")
        raise ValueError("ANTHROPIC_API_KEY is required for Stagehand")

    print(f"[BROWSER]   BROWSERBASE_PROJECT_ID = {bb_project_id}")
    print(f"[BROWSER]   BROWSERBASE_API_KEY    = {bb_api_key[:8]}...{bb_api_key[-4:]}")
    print(f"[BROWSER]   Anthropic key for Stagehand = from {anthropic_key_source} (len={len(anthropic_api_key)})")
    print(f"[BROWSER]   session model          = {STAGEHAND_SESSION_MODEL}")

    client: AsyncStagehand | None = None
    session: Any = None
    pw: Any = None
    browser: Any = None

    try:
        # Step 1: Create API client
        print("[BROWSER] Step 1/4: Creating AsyncStagehand client...")
        t1 = time.time()
        # Stagehand SDK names this argument `model_api_key`; value is ANTHROPIC_API_KEY only.
        client = AsyncStagehand(
            browserbase_api_key=bb_api_key,
            browserbase_project_id=bb_project_id,
            model_api_key=anthropic_api_key,
        )
        print(f"[BROWSER] Step 1/4: Client created ({time.time() - t1:.2f}s)")

        # Step 2: Start Stagehand session (creates Browserbase cloud browser)
        print("[BROWSER] Step 2/4: Starting Stagehand session (Browserbase cloud browser)...")
        t2 = time.time()
        session = await client.sessions.start(model_name=STAGEHAND_SESSION_MODEL)
        session_id = session.id
        print(f"[BROWSER] Step 2/4: Session started ({time.time() - t2:.2f}s)")
        print(f"[BROWSER]   session_id = {session_id}")
        print(f"[BROWSER]   live view  = https://www.browserbase.com/sessions/{session_id}")

        # Step 3: Connect Playwright to Browserbase session via CDP
        print("[BROWSER] Step 3/4: Connecting Playwright via CDP...")
        t3 = time.time()
        pw = await async_playwright().start()
        cdp_url = f"wss://connect.browserbase.com?apiKey={bb_api_key}&sessionId={session_id}"
        browser = await pw.chromium.connect_over_cdp(cdp_url)
        print(f"[BROWSER] Step 3/4: Playwright CDP connected ({time.time() - t3:.2f}s)")

        # Step 4: Acquire page from browser context
        print("[BROWSER] Step 4/4: Acquiring page from browser context...")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()
        print(f"[BROWSER] Step 4/4: Page acquired — url={page.url}")

    except BaseException as exc:
        elapsed = time.time() - t0
        print(f"[BROWSER] ERROR: Session creation failed after {elapsed:.2f}s")
        print(f"[BROWSER]   exception: {type(exc).__name__}: {exc}")
        print(f"[BROWSER]   allocated: client={'yes' if client else 'no'}, session={'yes' if session else 'no'}, "
              f"playwright={'yes' if pw else 'no'}, browser={'yes' if browser else 'no'}")
        print("[BROWSER]   cleaning up partial resources...")
        await _cleanup_partial(client, session, browser, pw)
        print("[BROWSER]   partial cleanup done")
        raise

    # Best-effort: fetch the embeddable live-view URL so the UI can show
    # the realtime session while the test runs. Failure here is non-fatal.
    live_view_urls = await fetch_live_view_urls(session_id, bb_api_key)

    elapsed = time.time() - t0
    print(f"[BROWSER] create_stagehand_session — completed in {elapsed:.2f}s")
    return {
        "client": client,
        "session": session,
        "session_id": session_id,
        "playwright": pw,
        "browser": browser,
        "page": page,
        "live_view_url": live_view_urls.get("embed_url"),
        "live_view_debugger_url": live_view_urls.get("debugger_url"),
        "live_view_fullscreen_url": live_view_urls.get("fullscreen_url"),
    }


async def fetch_live_view_urls(session_id: str, bb_api_key: str) -> dict[str, str | None]:
    """Fetch Browserbase's live-view (debug) URLs for an active session.

    Uses ``GET /v1/sessions/{id}/debug``. Returns a dict with:
      - ``embed_url``: fullscreen URL with ``&navbar=false`` for clean embedding
      - ``debugger_url``: with-borders URL (browser chrome)
      - ``fullscreen_url``: raw fullscreen URL

    Any failure is logged and swallowed — live-view is a nice-to-have
    and must never break a test run.
    """
    if not session_id or not bb_api_key:
        return {}

    url = f"https://api.browserbase.com/v1/sessions/{session_id}/debug"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                url,
                headers={
                    "x-bb-api-key": bb_api_key,
                    "Content-Type": "application/json",
                },
            )
        if response.status_code != 200:
            print(
                f"[BROWSER] live-view fetch non-200 ({response.status_code}) — "
                f"body preview: {response.text[:200]}"
            )
            return {}
        data = response.json()
    except Exception as e:
        print(f"[BROWSER] live-view fetch failed: {type(e).__name__}: {e}")
        return {}

    fullscreen = data.get("debuggerFullscreenUrl") or ""
    debugger_url = data.get("debuggerUrl") or ""
    embed_url = f"{fullscreen}&navbar=false" if fullscreen else ""

    print(f"[BROWSER]   live-view embed URL = {embed_url or '(none)'}")
    return {
        "embed_url": embed_url or None,
        "debugger_url": debugger_url or None,
        "fullscreen_url": fullscreen or None,
    }


async def _cleanup_partial(
    client: AsyncStagehand | None,
    session: Any,
    browser: Any,
    playwright_inst: Any,
) -> None:
    """Best-effort teardown of whatever resources were allocated so far."""
    if browser is not None:
        try:
            await browser.close()
            print("[BROWSER]   cleanup: browser closed")
        except Exception as e:
            print(f"[BROWSER]   cleanup: browser.close() failed: {e}")
    if playwright_inst is not None:
        try:
            await playwright_inst.stop()
            print("[BROWSER]   cleanup: playwright stopped")
        except Exception as e:
            print(f"[BROWSER]   cleanup: playwright.stop() failed: {e}")
    if session is not None:
        try:
            await session.end()
            print("[BROWSER]   cleanup: session ended")
        except Exception as e:
            print(f"[BROWSER]   cleanup: session.end() failed: {e}")
    if client is not None:
        try:
            await client.close()
            print("[BROWSER]   cleanup: client closed")
        except Exception as e:
            print(f"[BROWSER]   cleanup: client.close() failed: {e}")


async def cleanup_session(
    client: AsyncStagehand | None,
    session: Any,
    browser: Any,
    playwright_inst: Any,
) -> None:
    """Tear down Playwright + Stagehand session resources.

    Accepts None for any argument so callers don't need to guard against
    partial initialisation.
    """
    print("[BROWSER] cleanup_session — tearing down resources...")
    t0 = time.time()
    await _cleanup_partial(client, session, browser, playwright_inst)
    print(f"[BROWSER] cleanup_session — done ({time.time() - t0:.2f}s)")
