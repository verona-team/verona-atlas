"""
Prompt definitions and tool schemas for the outer QA ReAct agent (Claude Opus)
that drives the agentic test execution loop.
"""
import json
from typing import Any

# Stagehand session + inner execute agent (Browserbase). Provider/model form per Stagehand API.
STAGEHAND_AGENT_MODEL = "anthropic/claude-opus-4-6"
STAGEHAND_SESSION_MODEL = STAGEHAND_AGENT_MODEL

OUTER_AGENT_MODEL = "claude-opus-4-6"

TOOLS: list[dict[str, Any]] = [
    {
        "name": "browser_action",
        "description": (
            "Execute a browser action using the Stagehand AI browser agent. "
            "The agent will interpret your instruction and perform the necessary "
            "browser interactions (clicking, typing, scrolling, navigating, etc.). "
            "After execution, you will receive a screenshot of the resulting page state."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "instruction": {
                    "type": "string",
                    "description": (
                        "Natural language instruction describing what to do in the browser. "
                        "Be specific about which elements to interact with and what values to enter. "
                        "Examples: 'Click the Submit button', "
                        "'Type john@example.com in the email field', "
                        "'Navigate to the Settings page using the sidebar navigation'"
                    ),
                }
            },
            "required": ["instruction"],
        },
    },
    {
        "name": "observe_dom",
        "description": (
            "Perform a precise DOM-level observation to check whether specific "
            "elements, text, or states are present on the current page. Use this "
            "when you need programmatic verification beyond what is visible in "
            "screenshots — for example, checking for specific text content, "
            "element attributes, or hidden DOM states."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "What to look for on the page. Be descriptive. "
                        "Examples: 'a success toast message', "
                        "'an error banner with text containing failed', "
                        "'a table with at least 3 rows of data', "
                        "'a disabled Submit button'"
                    ),
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "save_credentials",
        "description": (
            "Save the credentials you used to create an account on the target "
            "platform. Call this immediately after you have successfully signed up "
            "and confirmed that the account works (e.g. you are logged in and can "
            "see the authenticated UI). These credentials will be stored and "
            "provided to you on future test runs so you can log in directly "
            "without creating a new account."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "email": {
                    "type": "string",
                    "description": "The email address used to create the account.",
                },
                "password": {
                    "type": "string",
                    "description": "The password used to create the account.",
                },
            },
            "required": ["email", "password"],
        },
    },
    {
        "name": "check_email",
        "description": (
            "Check your email inbox for recent messages. Use this to retrieve "
            "verification codes, confirmation links, or other emails sent during "
            "account signup or 2FA. Returns the most recent messages received "
            "since the test started, including subject lines, body text, any "
            "extracted verification/confirmation URLs, and numeric OTP codes. "
            "If a verification URL is returned, navigate to it using browser_action. "
            "If a numeric code is returned, enter it into the verification field."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "timeout_seconds": {
                    "type": "integer",
                    "description": (
                        "How long to wait (in seconds) for new messages before "
                        "giving up. Defaults to 30. Use a longer timeout if you "
                        "just triggered an email and expect a short delay."
                    ),
                }
            },
            "required": [],
        },
    },
    {
        "name": "complete_test",
        "description": (
            "Signal that the test flow execution is complete. Call this when you "
            "have finished executing all the steps in the test plan and verified "
            "the expected outcomes, OR when you have determined that testing cannot "
            "continue due to a blocking issue."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "passed": {
                    "type": "boolean",
                    "description": (
                        "Whether the overall test passed — all expected behaviors "
                        "were verified successfully."
                    ),
                },
                "summary": {
                    "type": "string",
                    "description": (
                        "Concise summary of what was tested, the actions taken, "
                        "and the outcome."
                    ),
                },
                "bugs_found": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "Clear description of the bug.",
                            },
                            "severity": {
                                "type": "string",
                                "enum": [
                                    "critical",
                                    "major",
                                    "minor",
                                    "cosmetic",
                                ],
                                "description": "Severity level of the bug.",
                            },
                            "step_context": {
                                "type": "string",
                                "description": (
                                    "Which test step or action revealed this bug."
                                ),
                            },
                        },
                        "required": ["description", "severity"],
                    },
                    "description": (
                        "Bugs or issues discovered during testing. "
                        "Empty array if none found."
                    ),
                },
            },
            "required": ["passed", "summary"],
        },
    },
]


def _build_auth_section(
    agentmail_address: str | None,
    existing_credentials: dict | None,
    generated_password: str | None,
) -> str:
    """Build the authentication instructions for the system prompt."""
    if not agentmail_address:
        return (
            "\n\n## Authentication\n\n"
            "No email inbox is configured for this project, so you cannot create "
            "accounts or handle email-based verification. If the application "
            "requires authentication, do your best to test any publicly accessible "
            "pages, and report that authentication was required but unavailable."
        )

    if existing_credentials:
        email = existing_credentials.get("email", "")
        password = existing_credentials.get("password", "")
        return (
            "\n\n## Authentication\n\n"
            "You have previously created an account on this platform. Use the "
            "credentials below to log in before executing the test plan.\n\n"
            f"- **Email:** `{email}`\n"
            f"- **Password:** `{password}`\n\n"
            "**Login instructions:**\n"
            "1. Look for a login/sign-in page or link on the application.\n"
            "2. Enter the email and password above.\n"
            "3. If the platform sends a verification email, use the `check_email` "
            "tool to retrieve it. If a numeric code is returned, enter it. If a "
            "confirmation link is returned, navigate to it with `browser_action`.\n"
            "4. Once you are logged in and can see the authenticated UI, proceed "
            "with the test plan.\n\n"
            "**If login fails** (e.g. invalid credentials, account locked/deleted), "
            "create a new account instead using the signup instructions below, then "
            "call `save_credentials` with the new credentials.\n\n"
            "**Fallback — creating a new account:**\n"
            f"- Use your email address: `{agentmail_address}`\n"
            f"- Use this password: `{generated_password}`\n"
            "- Navigate to the signup/register page and create the account.\n"
            "- If the platform sends a verification email, use `check_email` to "
            "retrieve it. Enter any numeric code, or navigate to any confirmation link.\n"
            "- After successfully signing up and confirming you are logged in, "
            "call `save_credentials` with the email and password you used."
        )

    return (
        "\n\n## Authentication\n\n"
        "This is the **first time** you are testing this platform. If the "
        "application requires authentication (login/signup) to access the pages "
        "you need to test, you must **create a new account**.\n\n"
        "**Your email address and password for signup:**\n"
        f"- **Email:** `{agentmail_address}`\n"
        f"- **Password:** `{generated_password}`\n\n"
        "**Signup instructions:**\n"
        "1. Look for a signup/register page or link on the application.\n"
        "2. Fill out the registration form using the email and password above. "
        "For any other required fields (name, etc.), use reasonable test data.\n"
        "3. If the platform sends a verification email, use the `check_email` tool "
        "to retrieve it. The tool will extract any verification codes and "
        "confirmation/verification URLs for you.\n"
        "   - **Verification code:** enter it into the code/OTP input field.\n"
        "   - **Confirmation link:** use `browser_action` to navigate to the URL.\n"
        "4. Once you have successfully signed up and can see the authenticated "
        "UI, **immediately call `save_credentials`** with the email and password "
        "you used. This saves your credentials so you can reuse them on future "
        "test runs.\n"
        "5. Then proceed with the test plan.\n\n"
        "**Important:** If the platform does NOT require authentication (all "
        "pages are publicly accessible), skip signup and go straight to the "
        "test plan."
    )


def build_system_prompt(
    template: dict,
    project: dict,
    integrations: dict[str, dict] | None = None,
    agentmail_address: str | None = None,
    existing_credentials: dict | None = None,
    generated_password: str | None = None,
) -> str:
    """Build the system prompt for the outer QA ReAct agent.

    Args:
        template: Test template dict with steps.
        project: Project dict from DB.
        integrations: Connected observability integrations.
        agentmail_address: The AgentMail address this agent can use for signup/2FA.
        existing_credentials: Dict with 'email' and 'password' if the agent has
            previously created an account for this project. None on first run.
        generated_password: A pre-generated strong password the agent should use
            when creating a new account. Provided when existing_credentials is None.
    """
    steps = template.get("steps", [])
    if isinstance(steps, str):
        steps = json.loads(steps)
    steps = sorted(steps, key=lambda s: s.get("order", 0))

    plan_lines: list[str] = []
    for i, step in enumerate(steps, 1):
        step_type = step.get("type", "action")
        instruction = step.get("instruction", "")
        expected = step.get("expected", "")
        url = step.get("url", "")

        line = f"{i}. [{step_type.upper()}] {instruction}"
        if url:
            line += f"  (URL: {url})"
        if expected:
            line += f"  — Expected: {expected}"
        plan_lines.append(line)

    test_plan = "\n".join(plan_lines) if plan_lines else "(No steps defined)"
    app_url = project.get("app_url", "unknown")
    project_name = project.get("name", "unknown")

    integration_section = ""
    if integrations:
        parts: list[str] = []
        if "sentry" in integrations:
            parts.append("- Sentry (error tracking)")
        if "posthog" in integrations:
            parts.append("- PostHog (product analytics)")
        if "langsmith" in integrations:
            parts.append("- LangSmith (LLM observability)")
        if "braintrust" in integrations:
            parts.append("- Braintrust (AI evaluations)")
        if parts:
            integration_section = (
                "\n\n## Connected Observability Integrations\n"
                + "\n".join(parts)
                + "\n\nErrors from these platforms are monitored automatically. "
                "Focus on the UI behavior you can observe directly."
            )

    auth_section = _build_auth_section(
        agentmail_address, existing_credentials, generated_password,
    )

    return f"""You are an expert QA testing agent. Your job is to execute a UI test flow on a web application by interacting with the browser and verifying that the application behaves correctly.

## Application Under Test
- **Name:** {project_name}
- **URL:** {app_url}
{auth_section}

## Test Plan

The following steps describe the UI test flow you need to execute. Treat these as **high-level goals** — you may need to adapt, add intermediate steps, or deviate from the plan based on the actual state of the UI.

{test_plan}
{integration_section}

## Your Workflow

You operate in a ReAct (Reason + Act) loop:
1. **Observe** the current state of the page via the screenshot provided to you
2. **Reason** about whether the previous action succeeded, what the current page state is, and what you should do next to continue testing
3. **Act** by calling one of your tools

Repeat this observe → reason → act cycle until the entire test flow is complete.

## Tools

- **browser_action** — Execute a browser interaction (click, type, navigate, scroll, etc.) via the Stagehand AI browser agent. After each action you will receive a screenshot showing the resulting page state.
- **observe_dom** — Perform a precise DOM-level check to verify element presence, text content, or other DOM state. Use this when you need programmatic confirmation beyond what you can see in the screenshot.
- **save_credentials** — Save the email and password you used to create an account on the target platform. Call this immediately after successful signup so you can reuse the credentials on future runs. Only call this after you have confirmed the account works.
- **check_email** — Check your email inbox for recent messages (verification codes, confirmation links, etc.). Use this when the platform sends a verification email during signup or login.
- **complete_test** — Signal that the test is finished. Call this once all steps are done and verified, or when you encounter an unrecoverable blocking issue.

## Guidelines

- **Authenticate first.** If the application requires login/signup, handle authentication before starting the test plan. Follow the authentication instructions above.
- **Be thorough.** Complete every step in the test plan. Do not skip steps unless genuinely blocked.
- **Be observant.** After each action, carefully examine the screenshot. Look for error messages, unexpected UI states, loading indicators, pop-ups, modals, or anything that suggests the action did not work as expected.
- **Be adaptive.** If the UI does not match what you expect (different layout, extra confirmation dialogs, changed button labels, new onboarding modals), adapt and find the correct way forward instead of failing.
- **Recover from errors.** If an action fails or produces an unexpected result, reason about what went wrong and try a different approach. You may need to dismiss a modal, scroll to find an element, wait for a page to load, or retry with a different selector.
- **Verify assertions visually.** When the test plan includes assertion steps (checking that something is visible or correct), use the screenshot as your **primary** verification method. Only use observe_dom when you need precise programmatic confirmation of DOM-level details.
- **Report real bugs.** If you observe behavior that is an actual application defect (not just a UI change or transient issue you can work around), record it in your final complete_test call. Clearly distinguish between "the UI changed and I adapted" versus "the application has a defect."
- **Be efficient.** Each browser_action call consumes resources. Plan your actions to minimize unnecessary or redundant steps while still being thorough.
- **Handle loading states.** After navigation or form submissions the page may take a moment to load. If a screenshot shows a loading/spinner state, you may need to wait and re-check by performing another browser_action."""


def build_tool_result_content(
    screenshot_b64: str | None,
    url: str,
    result_text: str,
) -> list[dict]:
    """Build tool-result content blocks including the post-action screenshot."""
    blocks: list[dict] = [
        {
            "type": "text",
            "text": f"Current URL: {url}\n\nResult: {result_text}",
        },
    ]
    if screenshot_b64:
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": screenshot_b64,
                },
            }
        )
    return blocks
