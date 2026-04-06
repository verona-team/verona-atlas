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

from stagehand import AsyncStagehand
from playwright.async_api import async_playwright

from runner.prompts import STAGEHAND_SESSION_MODEL


def _is_google_gemini_stagehand_model(model_name: str) -> bool:
    """True when the Stagehand session/agent uses Google Gemini (incl. Computer Use)."""
    m = (model_name or "").lower()
    return m.startswith("google/") or "gemini" in m


def get_google_api_key_for_stagehand() -> str:
    """API key for Gemini / Computer Use (Stagehand agentExecute and related calls).

    Google's API rejects unauthenticated calls with PERMISSION_DENIED (403). The inner browser
    agent must call Gemini with a Google AI Studio key — Anthropic keys are not valid there.

    Resolution order: MODEL_API_KEY (when set for the runner), then GOOGLE_API_KEY, then GEMINI_API_KEY.
    """
    key = (
        (os.environ.get("MODEL_API_KEY") or "").strip()
        or (os.environ.get("GOOGLE_API_KEY") or "").strip()
        or (os.environ.get("GEMINI_API_KEY") or "").strip()
    )
    if not key:
        raise ValueError(
            "Gemini Computer Use requires a Google API key. Set GOOGLE_API_KEY or GEMINI_API_KEY "
            "(or set MODEL_API_KEY to your Google AI Studio key). "
            "ANTHROPIC_API_KEY alone is not used for Stagehand browser actions."
        )
    return key


def _split_provider_model(model: str) -> tuple[str | None, str]:
    """Split 'provider/model-name' into (provider, model-name).

    Returns (None, model) when no '/' is present.
    """
    if "/" in model:
        provider, _, bare = model.partition("/")
        return provider, bare
    return None, model


def stagehand_agent_model_for_api(model_name: str | None = None) -> str:
    """Value for Stagehand observe `options.model`.

    Returns the provider-prefixed model string (e.g. "google/gemini-…").
    The Google API key is already set at the client level via model_api_key
    in create_stagehand_session(), so per-call ModelConfig is not needed.
    """
    return model_name or STAGEHAND_SESSION_MODEL


def build_execute_agent_config(
    model_name: str | None = None,
    *,
    mode: str = "cua",
    system_prompt: str | None = None,
) -> dict[str, Any]:
    """Build ``agent_config`` for ``session.execute()`` (agentExecute).

    The Stagehand agentExecute endpoint forwards the ``model`` value
    directly to the AI provider API.  When a provider-prefixed string
    like ``"anthropic/claude-opus-4-6"`` is used, the prefix is *not*
    stripped, causing Anthropic to return 404 "model not found".

    This helper splits the prefix into an explicit ``provider`` field
    and a bare model name so the server routes the request correctly.
    """
    full_model = model_name or STAGEHAND_SESSION_MODEL
    provider, bare_model = _split_provider_model(full_model)

    config: dict[str, Any] = {"model": bare_model, "mode": mode}
    if provider:
        config["provider"] = provider
    if system_prompt:
        config["system_prompt"] = system_prompt
    return config


def _resolve_model_api_key() -> str:
    """Key sent as x-model-api-key on AsyncStagehand (Browserbase Stagehand API).

    When the configured model is Google Gemini, only a Google API key is valid — do not fall back
    to ANTHROPIC_API_KEY or the session may start but agentExecute will fail with Google 403.
    """
    if _is_google_gemini_stagehand_model(STAGEHAND_SESSION_MODEL):
        return get_google_api_key_for_stagehand()
    return (
        (os.environ.get("MODEL_API_KEY") or "").strip()
        or (os.environ.get("GOOGLE_API_KEY") or "").strip()
        or (os.environ.get("GEMINI_API_KEY") or "").strip()
        or (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        or ""
    )


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
    model_api_key = _resolve_model_api_key()

    if not bb_api_key:
        print("[BROWSER] ERROR: BROWSERBASE_API_KEY is missing or empty")
        raise ValueError("BROWSERBASE_API_KEY environment variable is required")
    if not bb_project_id:
        print("[BROWSER] ERROR: BROWSERBASE_PROJECT_ID is missing or empty")
        raise ValueError("BROWSERBASE_PROJECT_ID environment variable is required")
    if not model_api_key:
        if _is_google_gemini_stagehand_model(STAGEHAND_SESSION_MODEL):
            print("[BROWSER] ERROR: no Google API key for Gemini Stagehand model")
            try:
                get_google_api_key_for_stagehand()
            except ValueError as e:
                raise ValueError(str(e)) from None
        print("[BROWSER] ERROR: no model API key (MODEL_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY)")
        raise ValueError(
            "MODEL_API_KEY, GOOGLE_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY is required for Stagehand"
        )

    print(f"[BROWSER]   BROWSERBASE_PROJECT_ID = {bb_project_id}")
    print(f"[BROWSER]   BROWSERBASE_API_KEY    = {bb_api_key[:8]}...{bb_api_key[-4:]}")
    key_kind = "google" if _is_google_gemini_stagehand_model(STAGEHAND_SESSION_MODEL) else "model"
    print(f"[BROWSER]   {key_kind} API key for Stagehand = set (len={len(model_api_key)})")
    print(f"[BROWSER]   session model          = {STAGEHAND_SESSION_MODEL}")

    client: AsyncStagehand | None = None
    session: Any = None
    pw: Any = None
    browser: Any = None

    try:
        # Step 1: Create API client
        print("[BROWSER] Step 1/4: Creating AsyncStagehand client...")
        t1 = time.time()
        client = AsyncStagehand(
            browserbase_api_key=bb_api_key,
            browserbase_project_id=bb_project_id,
            model_api_key=model_api_key,
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

    elapsed = time.time() - t0
    print(f"[BROWSER] create_stagehand_session — completed in {elapsed:.2f}s")
    return {
        "client": client,
        "session": session,
        "session_id": session_id,
        "playwright": pw,
        "browser": browser,
        "page": page,
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
