"""
Prompt definitions and tool schemas for the outer QA ReAct agent (Claude
Opus 4.7) that drives the agentic test execution loop.

The Stagehand browser-agent model is Claude Opus 4.6 because Stagehand's CUA /
agent mode is currently tuned for Claude-family models *and* the Stagehand v3
SDK only lists Opus up to 4.6 as a supported CUA model. Attempting to use
Opus 4.7 at the Stagehand layer fails at the Anthropic API because Stagehand
still emits the legacy ``computer_20250124`` tool schema, which 4.7 no longer
accepts (4.7 requires ``computer_20251124`` + the ``computer-use-2025-11-24``
beta header). See Browserbase's CUA-model list:
https://docs.stagehand.dev/v3/configuration/models

The outer ReAct loop is a different story: it talks to Anthropic directly
through ``langchain-anthropic`` using our own custom tool schema
(``TOOLS`` below, authored in Anthropic's native ``{name, description,
input_schema}`` shape), so it does NOT collide with the CUA ``computer_``
schema problem and safely runs on Opus 4.7.
"""
import json
from typing import Any

# Stagehand session + inner execute agent (Browserbase). Provider/model form per Stagehand API.
# Must be one of Stagehand v3's supported CUA models
# (https://docs.stagehand.dev/v3/configuration/models). Opus 4.7 is NOT on
# that list yet — do not bump this until Stagehand ships an Opus-4.7-compatible
# CUA integration.
STAGEHAND_AGENT_MODEL = "anthropic/claude-opus-4-6"
STAGEHAND_SESSION_MODEL = STAGEHAND_AGENT_MODEL

# Outer ReAct loop model — Claude Opus 4.7 via `langchain-anthropic`. This
# string is used by test_executor for logging only; the actual model
# instance is obtained via `runner.chat.models.get_claude_opus_outer()`.
OUTER_AGENT_MODEL = "claude-opus-4-7"

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
        "name": "navigate_to_url",
        "description": (
            "Navigate the browser directly to a specific URL. Use this when you "
            "need to visit a URL that you already know — for example, a verification "
            "or confirmation link from an email, an OAuth callback URL, or any "
            "specific page URL. This performs a programmatic navigation (like "
            "typing a URL in the address bar and pressing Enter). After navigation, "
            "you will receive a screenshot of the resulting page state."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": (
                        "The full URL to navigate to. Must start with http:// or https://. "
                        "Examples: 'https://example.com/verify?token=abc123', "
                        "'https://app.example.com/dashboard'"
                    ),
                }
            },
            "required": ["url"],
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
        "name": "click_selector",
        "description": (
            "Click an element identified by a CSS or xpath selector via Playwright "
            "directly. Bypasses the AI browser agent — clicks land deterministically "
            "on the matched element, with no perception loop. Use this when "
            "`browser_action` has failed twice in a row to click the same target. "
            "Typical pattern: call `observe_dom` first to get a selector, then call "
            "this tool with that selector. The xpath selectors returned by "
            "`observe_dom` (prefixed with `xpath=`) work as-is."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": (
                        "A CSS selector or xpath. xpath must be prefixed with "
                        "`xpath=`. Examples: 'button[aria-label=\"Submit\"]', "
                        "'xpath=/html/body/div[2]/main/div/button[1]'."
                    ),
                },
                "force": {
                    "type": "boolean",
                    "description": (
                        "If true, skip Playwright's actionability checks (visible, "
                        "stable, enabled, receiving events) and click anyway. "
                        "Use as a last resort for elements that are reachable in "
                        "the DOM but covered by an overlay or otherwise fail "
                        "actionability. Defaults to false."
                    ),
                },
                "nth": {
                    "type": "integer",
                    "description": (
                        "When the selector matches multiple elements, the 0-based "
                        "index of the one to click. Defaults to 0 (first match)."
                    ),
                },
            },
            "required": ["selector"],
        },
    },
    {
        "name": "fill_selector",
        "description": (
            "Fill an `<input>`, `<textarea>`, or `[contenteditable]` element "
            "identified by a selector with the given value, replacing any existing "
            "content. Bypasses the AI browser agent — values land deterministically. "
            "Use this when `browser_action` has failed to type into a field "
            "reliably. Typical pattern: call `observe_dom` first to get the "
            "selector, then call this tool. Works for password fields, search "
            "boxes, rich-text inputs, etc."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": (
                        "A CSS selector or xpath identifying the input element. "
                        "xpath must be prefixed with `xpath=`."
                    ),
                },
                "value": {
                    "type": "string",
                    "description": "The exact value to set on the field.",
                },
                "nth": {
                    "type": "integer",
                    "description": (
                        "When the selector matches multiple elements, the 0-based "
                        "index of the one to fill. Defaults to 0 (first match)."
                    ),
                },
            },
            "required": ["selector", "value"],
        },
    },
    {
        "name": "press_key",
        "description": (
            "Press a single key (or modifier+key combo) on the keyboard via "
            "Playwright. Use for Enter to submit forms, Escape to dismiss modals, "
            "Tab to advance focus, arrow keys for navigation, etc. If a `selector` "
            "is provided, the element is focused first and then the key is pressed "
            "on it; otherwise the key is dispatched to whatever currently has focus."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": (
                        "Key name in Playwright syntax. Examples: 'Enter', "
                        "'Escape', 'Tab', 'ArrowDown', 'Backspace', "
                        "'Control+A', 'Meta+K'."
                    ),
                },
                "selector": {
                    "type": "string",
                    "description": (
                        "Optional CSS or xpath selector. If provided, this element "
                        "is focused before pressing the key. Omit to send the key "
                        "to whatever element currently has focus."
                    ),
                },
            },
            "required": ["key"],
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
            "If a verification URL is returned, navigate to it using navigate_to_url. "
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
        "name": "wait",
        "description": (
            "Pause execution for a fixed duration without invoking the AI browser "
            "agent. Use this for asynchronous boundaries that resolve on their own "
            "(autosave flush, network fetch debounce, animation completion, "
            "background job progress, post-redirect settling). After the wait you "
            "receive a fresh screenshot of the current page state. ALWAYS prefer "
            "this over asking `browser_action` to wait — `browser_action` runs a "
            "multi-step AI perception loop and is much slower for waits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "seconds": {
                    "type": "number",
                    "description": (
                        "How long to wait, in seconds. Use the smallest duration "
                        "that's likely to satisfy the boundary you're waiting for. "
                        "Capped at 30 seconds — for longer waits, split across "
                        "multiple `wait` calls so you can re-observe in between."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": (
                        "Short explanation of what async boundary you are waiting "
                        "for (e.g. 'autosave flush', 'enrichment job to complete', "
                        "'modal close animation'). Logged for observability."
                    ),
                },
            },
            "required": ["seconds"],
        },
    },
    {
        "name": "complete_test",
        "description": (
            "Signal that the test flow execution is complete. Call this when you "
            "have finished executing all the steps in the test plan and verified "
            "the expected outcomes, OR when you have determined that testing cannot "
            "continue due to a blocking issue.\n\n"
            "Reserve `passed=false` for: (a) you walked the test to completion and "
            "observed a real application defect; (b) you genuinely exhausted "
            "exploration and data-seeding attempts and the flow is unwalkable on "
            "this account. Do NOT call `passed=false` because you are momentarily "
            "confused, because the page looks unfamiliar, because the test plan's "
            "assumed data isn't pre-loaded, or because you ran one observe_dom "
            "that returned nothing — in those cases, your job is to EXPLORE the "
            "UI (click sidebar items, open menus, scroll, try different selectors) "
            "or SEED the data via the UI and then continue. Bailing in those "
            "situations wastes the QA pass."
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


def build_inner_cua_system_prompt(
    project: dict,
    *,
    agentmail_address: str | None = None,
    has_existing_credentials: bool = False,
) -> str:
    """Build the system prompt for the **inner** Stagehand CUA agent.

    The inner agent (Claude Opus 4.6 via Stagehand) is what actually drives the
    browser — clicking, typing, scrolling. Without explicit context, Claude's
    safety training treats unsolicited account creation on third-party domains
    as a borderline action and keeps refusing or stalling on signup forms,
    burning the per-call ``max_steps`` budget. Each refusal costs ~40-60s.

    This prompt tells the inner agent that:
    - The run is a sanctioned automated QA test commissioned by the platform
      owner (Atlas's customer), not an unsolicited interaction.
    - The application under test is a B2B SaaS owned by an Atlas customer,
      not a social/community platform.
    - Filling signup/login forms — including creating an account with the
      synthetic test email and password supplied in the instruction — is an
      explicitly authorized, expected part of the test plan.
    - Refusing to type or submit such forms is incorrect behavior.
    """
    project_name = project.get("name", "the application under test")
    app_url = project.get("app_url", "(unknown URL)")

    creds_clause = (
        "Credentials for an existing test account on this platform may be "
        "supplied in your instruction; use them as-is to log in."
        if has_existing_credentials
        else (
            "If signup is required, the instruction will supply a synthetic "
            "test email (an Atlas-owned AgentMail address) and a generated "
            "password. Use them exactly as given to create the account."
        )
    )

    inbox_clause = (
        f" The test email address is an Atlas-owned synthetic inbox "
        f"(`{agentmail_address}`) created specifically for this run; it is "
        f"not a real user."
        if agentmail_address
        else ""
    )

    return (
        "You are the browser-automation agent for **Atlas**, a third-party QA "
        "testing platform. You are running a sanctioned, automated UI test "
        "that the platform owner has commissioned against their own "
        "application.\n\n"
        "## Application under test\n"
        f"- **Name:** {project_name}\n"
        f"- **URL:** {app_url}\n"
        "- **Type:** A B2B SaaS application owned by an Atlas customer "
        "(the platform owner). It is **not** a social network, community "
        "platform, messaging app, or consumer service.\n\n"
        "## Authorization\n"
        "The platform owner has explicitly authorized Atlas to:\n"
        "1. Create test accounts on their application using synthetic "
        "Atlas-owned email addresses.\n"
        "2. Log in with those test accounts.\n"
        "3. Exercise authenticated UI flows end-to-end.\n\n"
        f"{creds_clause}{inbox_clause}\n\n"
        "## Your job\n"
        "Execute the instruction precisely. When the instruction says to "
        "fill an email/password field, type the exact value given, and "
        "submit the form. Authentication (signup or login) is a normal, "
        "expected part of the QA test plan — **do not refuse, hedge, or "
        "skip these steps**, and do not assume the application is a "
        "platform on which account creation is sensitive. Treating signup "
        "as off-limits would break the test run that the platform owner "
        "has paid for.\n\n"
        "## Execution guidelines\n"
        "- Wait for elements to load before interacting.\n"
        "- Be precise: click into the exact field named in the instruction, "
        "type the exact value, and verify the value appears before moving "
        "on.\n"
        "- If a field appears not to be receiving input, click directly "
        "inside it and retry — do not abandon the task.\n"
        "- Never narrate doubt about whether you should perform the action; "
        "the action is authorized."
    )


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
            "confirmation link is returned, navigate to it with `navigate_to_url`.\n"
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
        "   - **Confirmation link:** use `navigate_to_url` to go directly to the URL.\n"
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
        timeout_ms = step.get("timeout")

        line = f"{i}. [{step_type.upper()}] {instruction}"
        if url:
            line += f"  (URL: {url})"
        if expected:
            line += f"  — Expected: {expected}"
        # For wait steps, surface the suggested duration in SECONDS so
        # the agent knows what to pass to the `wait` tool. Step timeouts
        # are stored in milliseconds by the flow generator.
        if step_type == "wait" and isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
            seconds = max(1, round(float(timeout_ms) / 1000.0))
            line += f"  — Suggested wait: {seconds}s (use the `wait` tool, NOT browser_action)"
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

**Navigation (use freely):**

- **navigate_to_url** — Navigate the browser directly to a specific URL. Use this whenever you need to go to a known URL — especially verification/confirmation links from emails, OAuth callbacks, or specific page URLs. This is more reliable than asking browser_action to navigate because it performs a direct programmatic navigation. After navigation you will receive a screenshot of the resulting page state.

**Deterministic Playwright tools (PREFERRED for single, identifiable affordances):**

- **observe_dom** — Perform a precise DOM-level check to verify element presence, text content, or other DOM state. Use this to GET A STABLE SELECTOR for the deterministic tools below; also use it for programmatic confirmation beyond what you can see in the screenshot. The xpath selectors returned (prefixed with `xpath=`) work as-is for `click_selector` / `fill_selector`.
- **click_selector** — Click an element by CSS or xpath selector via Playwright directly. Bypasses the AI browser agent — clicks land deterministically with no perception loop. ~1-2 seconds per call vs. 10-17s for an equivalent browser_action.
- **fill_selector** — Fill an input/textarea/contenteditable by selector. Same speed advantage as click_selector. The value is logged by length only, so passwords are safe.
- **press_key** — Press a key or modifier+key combo (Enter to submit, Escape to dismiss, Tab to focus, arrow keys, Control+A, Meta+K, etc.).

**AI browser agent (use sparingly, only when perception is needed):**

- **browser_action** — Execute a browser interaction via the Stagehand AI browser agent. The inner agent runs a multi-step perception loop and routinely takes 10-17 seconds per call, so reserve it for genuinely multi-step or perception-heavy work: scrolling to find off-screen content, navigating dynamic UIs whose state you can't predict, completing chains of actions where intermediate state matters, or driving fields whose location is hard to describe with a selector. For single clicks/fills on identifiable affordances, prefer the deterministic tools above.

**Workflow tools:**

- **save_credentials** — Save the email and password you used to create an account on the target platform. Call this immediately after successful signup so you can reuse the credentials on future runs. Only call this after you have confirmed the account works.
- **check_email** — Check your email inbox for recent messages (verification codes, confirmation links, etc.). Use this when the platform sends a verification email during signup or login.
- **wait** — Pause for a fixed duration (capped at 30 seconds) and receive a fresh screenshot. Use for any "wait for autosave / wait for animation / wait for background job" boundary. Always prefer this over asking `browser_action` to wait.
- **complete_test** — Signal that the test is finished. Call this once all steps are done and verified, or when you encounter an unrecoverable blocking issue.

## Resilience and UI exploration (this is critical — read carefully)

You are a HARDWORKING, RESILIENT QA agent. Giving up early is the single biggest failure mode you can have. Real users would not give up after one confused observation; neither do you. The platform owner has paid for a thorough QA pass — abandoning a flow because you are momentarily confused or because the page doesn't look like you expected wastes that pass.

There are TWO situations where less-resilient agents bail too early. In both, your job is to push through.

### Situation 1: The test plan assumes data that doesn't exist on this fresh account

Your test account is FRESH and EMPTY by default. The signup or login that just happened gives you a workspace with no sheets, no campaigns, no connected accounts, no historical data, no team members, no projects, no documents. The test plan above may assume data that does not yet exist on this account — for example "open an existing campaign", "select a populated sheet", "review pending actions in agent logs", "edit your team's settings", "click on an existing project".

When you encounter a step that depends on pre-existing data:

1. Do NOT terminate or call `complete_test(passed=false)` just because the data isn't there.
2. Treat creating that data as part of the test. Walk the same UI path a real user would take: create the sheet, populate it, run the campaign through to the state the test plan needs, then continue with the actual assertions.
3. The seeding step itself is a real exercise of the product — if seeding the prerequisite data fails or behaves oddly, that IS a meaningful test result. Document the seed-step behavior in your final summary.
4. Only call `complete_test(passed=false)` for missing prerequisites if you have actually attempted to seed the data via the UI AND the seeding itself failed in a way that exposes a real bug. In that case, document the seeding attempt and the failure in `bugs_found`.
5. If a step fundamentally cannot be seeded via the UI (e.g. it requires a second user account you don't have, or admin-only DB tooling you can't access), proceed with whatever portion of the flow IS testable, and report the unseeded portion as `inconclusive` in your final summary — not `passed: false`.

### Situation 2: You are confused or unsure where to click next

Sometimes the UI does not match what you expected. Maybe the button label changed. Maybe the affordance is in a sidebar, not the toolbar. Maybe a feature lives behind a menu you haven't opened. Maybe there's an onboarding modal in the way. Maybe the page looks empty because the data is filtered. Maybe your test plan referenced a URL or page that doesn't exist on this account yet.

When you do not immediately know how to perform the next step, **DO NOT BAIL**. Real users get confused too — they don't give up, they explore. Take the same approach.

**Spend several iterations actively EXPLORING the UI to deeply understand it before continuing the test plan:**

1. **Look at the navbar / top bar** — what links are there? Click each unfamiliar link in turn to see where it leads.
2. **Look at the sidebar** — what sections does it have? Click EVERY sidebar item to see what's inside. The affordance you need might be one click away in a section you haven't opened.
3. **Open every menu, dropdown, profile menu, "more" / "..." button, settings cog** — they often hide important affordances.
4. **Look at every visible button on the current page** — what does each do? Hover or click to find out.
5. **Scroll the page top to bottom** — is the affordance off-screen?
6. **Look for tabs, breadcrumbs, or filter controls** — they often gate content.
7. **If the page looks empty**, look for "create" / "new" / "+" / "get started" / "set up" affordances.
8. **If a URL 404s or redirects**, navigate to the workspace root and explore from there to find the right path. Hardcoded URLs in your test plan may use placeholder slugs that don't match this account's real URLs.

After you have explored, you will almost always know what to do next. Resume the test plan with that understanding.

**Use `observe_dom` aggressively when you are unsure** — try MULTIPLE distinct query phrasings against the same page before concluding an element is absent. "No matching elements found" on one query is NOT proof the element is absent; it's proof THAT query missed. Try at least 3 different phrasings (e.g. "the campaign approval button", "any button labeled approve", "the primary call-to-action button on this page") before concluding the affordance isn't there.

**Combine exploration with seed-data creation when both apply:** if the test wants you to "approve a campaign" AND there are no campaigns AND you don't yet know how to create one, your job is to (a) explore the UI to find the campaign-creation affordance, (b) create one, then (c) continue with the original test step. Do NOT bail in either situation — both are part of the test.

### General resilience rules

- An empty `observe_dom` result, an unexpected page state, or a failed action is a SIGNAL TO INVESTIGATE — never a signal to give up. Try at least 3 distinct strategies (different selectors, different navigation paths, different scroll positions, different menu paths, different sidebar sections) before concluding something is genuinely absent.
- Persist for many iterations of exploration before declaring blockage. The test plan is a HIGH-LEVEL GOAL — adapting and inventing intermediate steps to satisfy it is part of your job.
- Calling `complete_test(passed=false)` is a strong claim. Reserve it for: (a) you walked the test to completion and observed a real application defect; (b) you exhausted exploration AND data-seeding attempts AND multiple selector strategies, and the flow is genuinely unwalkable on this account. **Do NOT use it for "I'm confused" or "the data isn't there" or "the page looks unfamiliar."**
- When in doubt: **explore more, click more, observe more, type into search bars, open menus, scroll**. The cost of one more exploration iteration is much lower than the cost of falsely declaring a flow unrunnable.

## Guidelines

- **Authenticate first.** If the application requires login/signup, handle authentication before starting the test plan. Follow the authentication instructions above.
- **Be relentless.** Complete every step in the test plan. Do NOT skip steps. If you appear blocked, the correct response is almost always to seed missing data, observe more carefully, explore the UI for the right affordance, or try a different selector — not to give up. See the "Resilience and UI exploration" section above.
- **Be observant.** After each action, carefully examine the screenshot. Look for error messages, unexpected UI states, loading indicators, pop-ups, modals, or anything that suggests the action did not work as expected.
- **Be adaptive.** If the UI does not match what you expect, that is normal. Adapt: explore the page, click around the navbar and sidebar, open menus, and find the correct way forward. Adapting is part of your job, not a sign the test is unrunnable.
- **Recover from errors.** A failed action, an unexpected page, or an empty observation is a signal to investigate further — try a different approach, dismiss any blocking modal, scroll, switch tabs, or explore a different navigation path. Iterate; don't escalate to `complete_test(passed=false)` until you've genuinely exhausted strategies.
- **Prefer deterministic selectors over `browser_action` for clearly-identifiable affordances.** `browser_action` runs a multi-step AI perception loop and routinely takes 10-17 seconds per call. For any single click or single fill on an affordance with a stable label or role (a button by visible text, a link, an input with a label/placeholder, a checkbox, a select, a sidebar nav item), the faster and more reliable path is:
  1. Call `observe_dom` once to get a selector.
  2. Use `click_selector` / `fill_selector` / `press_key` to act.

  Use `browser_action` for genuinely multi-step or perception-heavy work: scrolling to find off-screen content, navigating dynamic UIs whose state you can't predict, completing chains of actions where intermediate state matters, or driving fields whose location is hard to describe with a selector.
- **Budget per template.** A typical template should use NO MORE than 2-3 `browser_action` calls. If you find yourself reaching for `browser_action` a fourth time, stop and ask: "is this affordance identifiable? Could I use observe_dom + click_selector / fill_selector instead?" Almost always, yes.
- **Hard escalation.** If `browser_action` produces an unsuccessful or ambiguous result on the same target twice in a row, you MUST escalate to `observe_dom` + deterministic tools — do not call `browser_action` a third time on that target.
- **Verify assertions visually.** When the test plan includes assertion steps (checking that something is visible or correct), use the screenshot as your **primary** verification method. Only use observe_dom when you need precise programmatic confirmation of DOM-level details.
- **Report real bugs.** If you observe behavior that is an actual application defect (not just a UI change or transient issue you can work around), record it in your final complete_test call. Clearly distinguish between "the UI changed and I adapted" versus "the application has a defect."
- **Handle loading states.** After navigation or form submissions the page may take a moment to load. If a screenshot shows a loading/spinner state, use the dedicated `wait` tool — never ask `browser_action` to wait."""


# `build_tool_result_content` was previously exported here for the raw
# Anthropic SDK loop. The outer executor now uses LangChain + Gemini 3 Pro
# and builds multimodal messages inline with LangChain's unified content
# block shape (`{type: "image", base64, mime_type}`), so that helper is
# gone. If you need a similar helper for a new provider, add it here
# rather than duplicating the content-block construction at call sites.
