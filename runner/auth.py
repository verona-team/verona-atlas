"""
Authentication handler for test apps.
Uses Stagehand v3 session.execute() for login + AgentMail for 2FA codes.
"""
import os
import re
import asyncio
import time
from datetime import datetime, timezone

from agentmail import AgentMail

from runner.browser import stagehand_agent_model_for_api


async def authenticate(page, session, project: dict, password: str):
    """Authenticate into the target application with optional 2FA.

    Args:
        page: Playwright Page for direct navigation
        session: Stagehand v3 AsyncSession for AI-powered actions
        project: Project dict with auth_email, app_url, etc.
        password: Decrypted password
    """
    app_url = project["app_url"].rstrip("/")
    email = project["auth_email"]
    login_url = f"{app_url}/login"

    print(f"[AUTH] authenticate — email={email}")
    print(f"[AUTH]   navigating to {login_url}")

    t0 = time.time()
    await page.goto(login_url)
    await asyncio.sleep(2)
    print(f"[AUTH]   page loaded ({time.time() - t0:.1f}s) — url={page.url}")

    print("[AUTH]   submitting login form via Stagehand execute...")
    login_t0 = time.time()
    try:
        await session.execute(
            execute_options={
                "instruction": (
                    f'Enter the email "{email}" in the email/username field, '
                    f'enter the password "{password}" in the password field, '
                    f'then click the login/sign-in button.'
                ),
                "max_steps": 10,
            },
            agent_config={"model": stagehand_agent_model_for_api(), "mode": "cua"},
            timeout=60.0,
        )
        print(f"[AUTH]   login form submitted ({time.time() - login_t0:.1f}s)")
    except Exception as e:
        print(f"[AUTH]   login form submission FAILED ({time.time() - login_t0:.1f}s): {type(e).__name__}: {e}")
        raise

    await asyncio.sleep(3)
    print(f"[AUTH]   post-login url = {page.url}")

    print("[AUTH]   checking for 2FA prompt via Stagehand observe...")
    observe_t0 = time.time()
    try:
        observe_response = await session.observe(
            instruction="Is there a verification code input, 2FA input, OTP input, or any multi-factor authentication prompt?",
            options={"model": stagehand_agent_model_for_api()},
        )
        results = observe_response.data.result
        has_2fa = bool(results and len(results) > 0)
        print(f"[AUTH]   2FA check ({time.time() - observe_t0:.1f}s): detected={has_2fa} elements={len(results) if results else 0}")
    except Exception as e:
        print(f"[AUTH]   2FA check FAILED ({time.time() - observe_t0:.1f}s): {type(e).__name__}: {e}")
        raise

    if has_2fa:
        print("[AUTH]   2FA detected — entering handle_2fa flow")
        await handle_2fa(session, project)
    else:
        print("[AUTH]   no 2FA detected — authentication complete")

    total = time.time() - t0
    print(f"[AUTH] authenticate — done ({total:.1f}s)")


async def handle_2fa(session, project: dict):
    """Handle 2FA by polling AgentMail for verification code."""
    inbox_id = project.get("agentmail_inbox_id")
    if not inbox_id:
        print("[AUTH] ERROR: 2FA detected but no AgentMail inbox configured")
        raise ValueError("2FA detected but no AgentMail inbox configured for this project")

    print(f"[AUTH] handle_2fa — polling AgentMail inbox={inbox_id}")
    agentmail = AgentMail(api_key=os.environ["AGENTMAIL_API_KEY"])

    poll_start = datetime.now(timezone.utc)
    timeout_seconds = 60
    code = None
    poll_count = 0

    while (datetime.now(timezone.utc) - poll_start).total_seconds() < timeout_seconds:
        poll_count += 1
        try:
            list_resp = agentmail.inboxes.messages.list(inbox_id=inbox_id, limit=5)
            rows = list_resp.messages or []
        except Exception as e:
            print(f"[AUTH]   poll #{poll_count}: AgentMail list failed: {type(e).__name__}: {e}")
            await asyncio.sleep(2)
            continue

        for msg in rows:
            msg_date = msg.created_at
            if msg_date.tzinfo is None:
                msg_date = msg_date.replace(tzinfo=timezone.utc)
            if msg_date < poll_start:
                continue

            text = (msg.text or msg.subject or msg.preview or "") or ""
            match = re.search(r"\b(\d{4,8})\b", text)
            if match:
                code = match.group(1)
                print(f"[AUTH]   poll #{poll_count}: found 2FA code={code} (from subject={msg.subject!r})")
                break

        if code:
            break

        elapsed = (datetime.now(timezone.utc) - poll_start).total_seconds()
        print(f"[AUTH]   poll #{poll_count}: no code yet ({elapsed:.0f}s / {timeout_seconds}s)")
        await asyncio.sleep(2)

    if not code:
        print(f"[AUTH] ERROR: 2FA code not received within {timeout_seconds}s after {poll_count} polls")
        raise TimeoutError(f"2FA code not received within {timeout_seconds}s")

    print(f"[AUTH]   submitting 2FA code via Stagehand execute...")
    t0 = time.time()
    try:
        await session.execute(
            execute_options={
                "instruction": f'Enter the verification code "{code}" in the verification/OTP input field and submit.',
                "max_steps": 5,
            },
            agent_config={"model": stagehand_agent_model_for_api(), "mode": "cua"},
            timeout=30.0,
        )
        print(f"[AUTH]   2FA code submitted ({time.time() - t0:.1f}s)")
    except Exception as e:
        print(f"[AUTH]   2FA code submission FAILED ({time.time() - t0:.1f}s): {type(e).__name__}: {e}")
        raise

    await asyncio.sleep(2)
    print("[AUTH] handle_2fa — done")
