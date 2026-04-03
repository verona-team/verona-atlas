"""
Authentication handler for test apps.
Uses Stagehand agent() for login + AgentMail for 2FA codes.
"""
import os
import re
import asyncio
from datetime import datetime, timezone

from agentmail import AgentMail


async def authenticate(stagehand, project: dict, password: str):
    """Authenticate into the target application with optional 2FA."""
    app_url = project["app_url"].rstrip("/")
    email = project["auth_email"]
    
    # Navigate to login
    page = stagehand.page
    await page.goto(f"{app_url}/login")
    await asyncio.sleep(2)  # Wait for page load
    
    # Use agent for login flow
    agent = stagehand.agent(
        model="google/gemini-2.5-computer-use-preview-10-2025",
        system_prompt="You are a QA tester logging into a web application. Be precise and wait for elements to load.",
    )
    
    await agent.execute(
        f'Enter the email "{email}" in the email/username field, '
        f'enter the password "{password}" in the password field, '
        f'then click the login/sign-in button.',
        max_steps=10,
    )
    
    await asyncio.sleep(3)  # Wait for login to process
    
    # Check for 2FA
    observations = await stagehand.observe(
        "Is there a verification code input, 2FA input, OTP input, or any multi-factor authentication prompt?"
    )
    
    if observations and len(observations) > 0:
        await handle_2fa(stagehand, project, agent)


async def handle_2fa(stagehand, project: dict, agent):
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
    
    # Enter the 2FA code
    await agent.execute(
        f'Enter the verification code "{code}" in the verification/OTP input field and submit.',
        max_steps=5,
    )
    
    await asyncio.sleep(2)
