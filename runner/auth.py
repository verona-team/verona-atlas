"""
Authentication handler for test apps.
Uses Stagehand v3 session.execute() for login + AgentMail for 2FA codes.
"""
import os
import re
import asyncio
from datetime import datetime, timezone

from agentmail import AgentMail

from runner.prompts import STAGEHAND_AGENT_MODEL


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
    
    await page.goto(f"{app_url}/login")
    await asyncio.sleep(2)
    
    await session.execute(
        execute_options={
            "instruction": (
                f'Enter the email "{email}" in the email/username field, '
                f'enter the password "{password}" in the password field, '
                f'then click the login/sign-in button.'
            ),
            "max_steps": 10,
        },
        agent_config={"model": STAGEHAND_AGENT_MODEL},
        timeout=60.0,
    )
    
    await asyncio.sleep(3)
    
    observe_response = await session.observe(
        instruction="Is there a verification code input, 2FA input, OTP input, or any multi-factor authentication prompt?",
    )
    
    results = observe_response.data.result if hasattr(observe_response, "data") else []
    if results and len(results) > 0:
        await handle_2fa(session, project)


async def handle_2fa(session, project: dict):
    """Handle 2FA by polling AgentMail for verification code."""
    inbox_id = project.get("agentmail_inbox_id")
    if not inbox_id:
        raise ValueError("2FA detected but no AgentMail inbox configured for this project")
    
    agentmail = AgentMail(api_key=os.environ["AGENTMAIL_API_KEY"])

    poll_start = datetime.now(timezone.utc)
    timeout_seconds = 60
    code = None

    while (datetime.now(timezone.utc) - poll_start).total_seconds() < timeout_seconds:
        list_resp = agentmail.inboxes.messages.list(inbox_id=inbox_id, limit=5)
        rows = list_resp.messages or []

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
                break

        if code:
            break

        await asyncio.sleep(2)
    
    if not code:
        raise TimeoutError(f"2FA code not received within {timeout_seconds}s")
    
    await session.execute(
        execute_options={
            "instruction": f'Enter the verification code "{code}" in the verification/OTP input field and submit.',
            "max_steps": 5,
        },
        agent_config={"model": STAGEHAND_AGENT_MODEL},
        timeout=30.0,
    )
    
    await asyncio.sleep(2)
