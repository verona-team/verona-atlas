# Action Plan: External Service Integrations

> Robust GitHub, Sentry, PostHog, LangSmith, and Braintrust integrations so the QA agent can pull code context, detect runtime errors, and trace LLM calls — then surface everything in Slack reports.

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Phase 1 — Database & Schema Changes](#2-phase-1--database--schema-changes)
3. [Phase 2 — GitHub App (Private Repo Support)](#3-phase-2--github-app-private-repo-support)
4. [Phase 3 — Sentry Integration](#4-phase-3--sentry-integration)
5. [Phase 4 — PostHog Hardening](#5-phase-4--posthog-hardening)
6. [Phase 5 — LangSmith Integration](#6-phase-5--langsmith-integration)
7. [Phase 6 — Braintrust Integration](#7-phase-6--braintrust-integration)
8. [Phase 7 — Runner: Pull Logs During Test Execution](#8-phase-7--runner-pull-logs-during-test-execution)
9. [Phase 8 — Slack Report Enrichment](#9-phase-8--slack-report-enrichment)
10. [Phase 9 — New Project Flow Overhaul](#10-phase-9--new-project-flow-overhaul)
11. [Phase 10 — Settings Page & Integration Management](#11-phase-10--settings-page--integration-management)
12. [Environment Variables & Secrets](#12-environment-variables--secrets)
13. [Security Considerations](#13-security-considerations)
14. [Appendix: Integration Config Schemas](#14-appendix-integration-config-schemas)

---

## 1. Current State Audit

### What exists today

| Integration | Frontend | API Route | Library (`lib/`) | Runner (`runner/`) | DB Row | Status |
|------------|----------|-----------|-------------------|--------------------|--------|--------|
| **GitHub** | Text input (`owner/repo`) on new-project form | Install redirect + callback (`/api/integrations/github/*`) | `lib/github.ts` — App JWT, installation token, commits, diffs | `runner/integrations.py` — `fetch_recent_commits` | `integrations` row with `type='github'`, stores `installation_id` + `setup_action` | **Partially wired**: callback does NOT store selected `repo`; form input value is never persisted; template generator expects `config.repo` which is never set; runner expects `config.repos` (array) |
| **PostHog** | Text input on new-project form | `/api/integrations/posthog/connect` — validates key, encrypts, upserts | `lib/posthog.ts` — sessions, errors, top pages | `runner/integrations.py` — `fetch_posthog_sessions`, `fetch_posthog_errors` | `integrations` row with `type='posthog'` | **Mostly works**: connect route validates + stores encrypted key; form value is not sent through the connect route though (form POSTs to `/api/projects` which ignores it) |
| **Slack** | None on new-project form | OAuth authorize + callback (`/api/integrations/slack/*`) | `lib/slack.ts` — OAuth, channels, postMessage, Block Kit | `runner/reporter.py` — `send_slack_report` | `integrations` row with `type='slack'` | **Partially works**: OAuth stores `bot_token_encrypted` but no `channel_id` is ever set in config; runner requires `channel_id` to send messages |
| **Sentry** | Text input on new-project form (placeholder: "DSN or project slug") | **None** | **None** | **None** | **No enum value** | **UI-only stub** |
| **LangSmith** | Text input on new-project form (placeholder: "API key") | **None** | **None** | **None** | **No enum value** | **UI-only stub** |
| **Braintrust** | Shares input with LangSmith | **None** | **None** | **None** | **No enum value** | **Nothing** |

### Key gaps to close

1. **GitHub**: Installation callback must persist the user's selected repository list; the `owner/repo` text input should be replaced with an OAuth-driven repo picker; the form ↔ API ↔ DB pipeline is disconnected.
2. **Sentry**: Needs full implementation — enum value, connect route, API client library, runner integration.
3. **PostHog**: Mostly done; needs the new-project form to flow through the existing connect route (or defer to settings).
4. **LangSmith**: Needs full implementation — enum value, connect route, API client library, runner integration.
5. **Braintrust**: Needs full implementation — enum value, connect route, API client library, runner integration.
6. **Slack**: Missing `channel_id` selection UI/API; runner cannot send reports without it.
7. **Runner**: Needs Sentry, LangSmith, and Braintrust client code to pull real-time logs during test execution.
8. **Slack reports**: Should include errors/traces from all connected observability platforms, not just test results.

---

## 2. Phase 1 — Database & Schema Changes

### 2.1 Extend the `integration_type` enum

**File**: new migration `supabase/migrations/011_add_integration_types.sql`

```sql
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'sentry';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'langsmith';
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'braintrust';
```

### 2.2 Update generated TypeScript types

**File**: `lib/supabase/types.ts`

Add `'sentry' | 'langsmith' | 'braintrust'` to the `integration_type` enum union so TypeScript code compiles when inserting/querying new types.

### 2.3 No new tables needed

All integrations use the existing `integrations` table with `config JSONB`. Each integration type defines its own config shape (documented in the appendix).

---

## 3. Phase 2 — GitHub App (Private Repo Support)

### Why this matters

The current text input (`owner/repo`) cannot access private repositories. A GitHub App installation grants scoped access to the repos the user selects during the install flow — including private repos. The install/callback routes exist but are incomplete.

### 3.1 Fix the GitHub callback to persist selected repos

**File**: `app/api/integrations/github/callback/route.ts`

After receiving the `installation_id`, use the GitHub API to list the repositories the installation has access to and store them in `config.repos`.

```
Steps:
1. After obtaining installation_id, call `GET /installation/repositories` using an installation access token.
2. Map the response to an array of `{ full_name, private, default_branch }` objects.
3. Store in config: { installation_id, setup_action, repos: [...] }
4. Upsert the integrations row as today.
```

**File**: `lib/github.ts`

Add a new function:

```typescript
export async function listInstallationRepos(installationId: number): Promise<Array<{
  fullName: string
  private: boolean
  defaultBranch: string
}>>
```

### 3.2 Add a repo-selection API endpoint

**File**: new `app/api/integrations/github/repos/route.ts`

- **GET**: Given a `project_id`, look up the GitHub integration's `installation_id`, fetch available repos from GitHub, and return them.
- **PATCH**: Accept `{ project_id, repos: string[] }` to update the selected repos stored in `config.repos`.

This lets the frontend show a multi-select repo picker after the GitHub App is installed.

### 3.3 Add a webhook for installation changes (optional but recommended)

**File**: new `app/api/webhooks/github/route.ts`

Listen for `installation_repositories` events so that when a user adds/removes repo access in GitHub settings, the `config.repos` list stays in sync.

- Verify the webhook signature using the GitHub App's webhook secret.
- On `added`/`removed` events, update the corresponding `integrations` row.

### 3.4 Replace the text input on the new-project form

**File**: `app/(dashboard)/projects/new/page.tsx`

Replace the `GitHub repository` text input with a two-step flow:

1. **If no GitHub App installed**: Show a "Connect GitHub" button that redirects to `/api/integrations/github/install?project_id=<id>`.  
   - **Problem**: The project doesn't exist yet at form-submission time. **Solution**: Create the project first (POST `/api/projects`), then redirect to the GitHub install flow with the new project ID. Alternatively, show the GitHub connect button on the project settings page post-creation.
   - **Recommended approach**: Split creation into two stages — basic project info first, then an "Integrations" step that opens after the project is created. This is cleaner UX.
2. **If GitHub App already installed for the org**: Show a dropdown/multi-select of available repos fetched from `GET /api/integrations/github/repos?project_id=<id>`.

### 3.5 Wire repos into the template generator

**File**: `app/api/templates/generate/route.ts`

Currently reads `config.repo` (singular string). Update to read `config.repos` (array) and iterate, fetching commits for each repo:

```typescript
const repos = (config.repos as string[]) || []
for (const repo of repos.slice(0, 3)) {
  const repoCommits = await fetchRecentCommits(installationId, repo)
  commits.push(...repoCommits)
}
```

### 3.6 Align runner with new config shape

**File**: `runner/integrations.py`

The runner already expects `config.repos` as an array — this is correct. Verify that the shape written by the callback matches what the runner reads. Ensure `repos` values are `"owner/repo"` strings.

---

## 4. Phase 3 — Sentry Integration

### Authentication approach

Sentry supports two methods:
- **Internal Integration (Auth Token)**: User provides an auth token + organization slug. Simpler, recommended for MVP.
- **OAuth**: More seamless but requires registering a Sentry OAuth app.

**Recommendation**: Start with **Auth Token** approach for speed, with OAuth as a follow-up.

### 4.1 Create the Sentry client library

**File**: new `lib/sentry.ts`

```typescript
export interface SentryConfig {
  authToken: string
  organizationSlug: string
  projectSlug: string
}

// Validate credentials against Sentry API
export async function validateSentryConnection(config: SentryConfig): Promise<boolean>

// Fetch recent issues (errors) from Sentry
export async function fetchRecentIssues(
  config: SentryConfig,
  sinceDays?: number
): Promise<Array<{
  id: string
  title: string
  culprit: string
  count: number
  firstSeen: string
  lastSeen: string
  level: string
  status: string
}>>

// Fetch events for a specific issue
export async function fetchIssueEvents(
  config: SentryConfig,
  issueId: string,
  limit?: number
): Promise<unknown[]>

// Fetch real-time events within a time window (for use during test runs)
export async function fetchRecentEvents(
  config: SentryConfig,
  sinceMinutes?: number
): Promise<Array<{
  eventId: string
  title: string
  message: string
  level: string
  timestamp: string
  tags: Record<string, string>
  url?: string
}>>
```

Sentry API base: `https://sentry.io/api/0/`

Key endpoints:
- `GET /projects/{org}/{project}/` — validate credentials
- `GET /projects/{org}/{project}/issues/?query=is:unresolved&sort=date` — recent issues
- `GET /projects/{org}/{project}/events/?full=true` — recent events

### 4.2 Create the connect API route

**File**: new `app/api/integrations/sentry/connect/route.ts`

```
Steps:
1. Accept { projectId, authToken, organizationSlug, projectSlug }
2. Validate with Zod
3. Auth check (user + org membership + project ownership)
4. Call validateSentryConnection() to verify credentials
5. Encrypt authToken using lib/encryption
6. Upsert integrations row: type='sentry', config={ auth_token_encrypted, organization_slug, project_slug }
7. Return { success: true }
```

### 4.3 Add Sentry to the runner

**File**: new section in `runner/integrations.py`

```python
async def fetch_sentry_issues(config: dict, since_days: int = 7) -> list[dict]:
    """Fetch recent unresolved issues from Sentry."""

async def fetch_sentry_events_realtime(config: dict, since_minutes: int = 5) -> list[dict]:
    """Fetch events that occurred in the last N minutes (for live test monitoring)."""
```

### 4.4 Config schema

```json
{
  "auth_token_encrypted": "iv:tag:cipher",
  "organization_slug": "my-org",
  "project_slug": "my-project"
}
```

---

## 5. Phase 4 — PostHog Hardening

PostHog is the most complete integration. This phase focuses on closing remaining gaps.

### 5.1 Fix the new-project form → PostHog connect flow

Currently the form sends `posthog_key` to `POST /api/projects`, which ignores it. Two options:

**Option A (recommended)**: Remove PostHog fields from the new-project form. After project creation, redirect to settings where the user connects PostHog via the existing `/api/integrations/posthog/connect` route.

**Option B**: After creating the project in `POST /api/projects`, chain a call to `/api/integrations/posthog/connect` if `posthog_key` is provided. This requires also collecting `posthog_project_id` on the form.

### 5.2 Add PostHog API host configuration

**File**: `app/api/integrations/posthog/connect/route.ts`

Allow users to specify a custom API host (EU instance: `https://eu.posthog.com`, self-hosted instances). Currently hardcoded to `POSTHOG_API_HOST` env var. Update the connect schema to accept an optional `apiHost` field.

### 5.3 Real-time event fetching for test runs

**File**: `lib/posthog.ts`

Add a function to fetch events within a narrow time window, for use during active test runs:

```typescript
export async function fetchRealtimeEvents(
  config: PostHogConfig,
  sinceMinutes: number = 5
): Promise<Array<{ event: string; timestamp: string; properties: Record<string, unknown> }>>
```

---

## 6. Phase 5 — LangSmith Integration

### Authentication approach

LangSmith uses **API keys** for authentication. The user provides their LangSmith API key and optionally a project name (LangSmith organizes traces by project).

### 6.1 Create the LangSmith client library

**File**: new `lib/langsmith.ts`

```typescript
export interface LangSmithConfig {
  apiKey: string
  apiUrl?: string  // defaults to https://api.smith.langchain.com
}

// Validate API key
export async function validateLangSmithConnection(config: LangSmithConfig): Promise<boolean>

// List projects/workspaces
export async function listProjects(config: LangSmithConfig): Promise<Array<{
  id: string
  name: string
}>>

// Fetch recent LLM trace runs
export async function fetchRecentRuns(
  config: LangSmithConfig,
  projectName?: string,
  sinceMinutes?: number
): Promise<Array<{
  id: string
  name: string
  runType: string
  status: string
  error?: string
  startTime: string
  endTime?: string
  latencyMs?: number
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
}>>

// Fetch runs with errors (failed LLM calls)
export async function fetchFailedRuns(
  config: LangSmithConfig,
  projectName?: string,
  sinceMinutes?: number
): Promise<Array<{...}>>
```

LangSmith API base: `https://api.smith.langchain.com`

Key endpoints:
- `GET /api/v1/sessions` — list projects
- `POST /api/v1/runs/query` — query runs with filters (status, time range, etc.)
- `GET /api/v1/runs/{run_id}` — get run details

### 6.2 Create the connect API route

**File**: new `app/api/integrations/langsmith/connect/route.ts`

```
Steps:
1. Accept { projectId, langsmithApiKey, langsmithProjectName? }
2. Validate with Zod
3. Auth check
4. Call validateLangSmithConnection() to verify the key
5. Encrypt API key
6. Upsert integrations row: type='langsmith', config={ api_key_encrypted, project_name?, api_url? }
7. Return { success: true }
```

### 6.3 Add LangSmith to the runner

**File**: new section in `runner/integrations.py`

```python
async def fetch_langsmith_traces(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch recent LLM traces from LangSmith during test execution."""

async def fetch_langsmith_errors(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch failed LLM runs from LangSmith."""
```

### 6.4 Config schema

```json
{
  "api_key_encrypted": "iv:tag:cipher",
  "project_name": "default",
  "api_url": "https://api.smith.langchain.com"
}
```

---

## 7. Phase 6 — Braintrust Integration

### Authentication approach

Braintrust uses **API keys**. The user provides their Braintrust API key and project name.

### 7.1 Create the Braintrust client library

**File**: new `lib/braintrust.ts`

```typescript
export interface BraintrustConfig {
  apiKey: string
  apiUrl?: string  // defaults to https://api.braintrust.dev
}

// Validate API key
export async function validateBraintrustConnection(config: BraintrustConfig): Promise<boolean>

// List projects
export async function listProjects(config: BraintrustConfig): Promise<Array<{
  id: string
  name: string
}>>

// Fetch recent experiment logs
export async function fetchRecentLogs(
  config: BraintrustConfig,
  projectName?: string,
  sinceMinutes?: number
): Promise<Array<{
  id: string
  input: unknown
  output: unknown
  expected?: unknown
  scores?: Record<string, number>
  error?: string
  metadata?: Record<string, unknown>
  created: string
}>>

// Fetch experiments with scores below threshold
export async function fetchFailedExperiments(
  config: BraintrustConfig,
  projectName?: string,
  scoreThreshold?: number
): Promise<Array<{...}>>
```

Braintrust API base: `https://api.braintrust.dev`

Key endpoints:
- `GET /v1/project` — list projects
- `GET /v1/project/{project_id}/logs` — fetch logs
- `GET /v1/experiment` — list experiments
- `GET /v1/experiment/{experiment_id}/fetch` — fetch experiment results

### 7.2 Create the connect API route

**File**: new `app/api/integrations/braintrust/connect/route.ts`

```
Steps:
1. Accept { projectId, braintrustApiKey, braintrustProjectName? }
2. Validate with Zod
3. Auth check
4. Call validateBraintrustConnection() to verify the key
5. Encrypt API key
6. Upsert integrations row: type='braintrust', config={ api_key_encrypted, project_name?, api_url? }
7. Return { success: true }
```

### 7.3 Add Braintrust to the runner

**File**: new section in `runner/integrations.py`

```python
async def fetch_braintrust_logs(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch recent evaluation logs from Braintrust during test execution."""

async def fetch_braintrust_errors(config: dict, since_minutes: int = 10) -> list[dict]:
    """Fetch failed evaluations from Braintrust."""
```

### 7.4 Config schema

```json
{
  "api_key_encrypted": "iv:tag:cipher",
  "project_name": "my-project",
  "api_url": "https://api.braintrust.dev"
}
```

---

## 8. Phase 7 — Runner: Pull Logs During Test Execution

This is the core value: while the QA agent is testing the user's app in the browser, it simultaneously pulls logs from all connected observability platforms to detect errors in real time.

### 8.1 Create a unified integration data fetcher

**File**: new `runner/observability.py`

```python
async def collect_observability_data(
    integrations: dict[str, dict],
    window_minutes: int = 5
) -> dict:
    """
    Pull real-time data from all connected observability platforms.
    Called before and after each test template execution.
    Returns:
    {
        "sentry_errors": [...],
        "posthog_errors": [...],
        "langsmith_traces": [...],
        "langsmith_errors": [...],
        "braintrust_logs": [...],
        "braintrust_errors": [...]
    }
    """
```

### 8.2 Integrate into the test execution pipeline

**File**: `runner/execute.py` — `execute_single_template`

```python
# Before test execution
pre_snapshot = await collect_observability_data(integrations, window_minutes=1)

# ... execute template ...

# After test execution (wait a brief period for logs to propagate)
await asyncio.sleep(3)
post_snapshot = await collect_observability_data(integrations, window_minutes=2)

# Diff the snapshots to find new errors introduced during the test
new_errors = diff_observability_snapshots(pre_snapshot, post_snapshot)
```

### 8.3 Store observability findings in test results

Update the `test_results` insert to include observability data:

```python
result = {
    "test_run_id": test_run_id,
    "test_template_id": template["id"],
    "status": status,
    "duration_ms": duration_ms,
    "error_message": error_message,
    "screenshots": screenshots,
    "console_logs": {
        "steps": step_results,
        "observability": new_errors,  # NEW
    },
}
```

### 8.4 Update the test planner

**File**: `runner/planner.py`

Feed Sentry issues, LangSmith errors, and Braintrust failures into the Claude prompt alongside GitHub commits and PostHog data. This gives the planner richer context for prioritizing which tests to run.

---

## 9. Phase 8 — Slack Report Enrichment

### 9.1 Fix the missing `channel_id` problem

**File**: `app/api/integrations/slack/callback/route.ts`

After storing the bot token, redirect to a channel-selection UI. Options:

**Option A**: Add `channel_id` to the Slack OAuth state, letting the user pick a channel on a settings page. After OAuth, show a dropdown of channels (fetched via `listChannels()`) and save the selection via a new `PATCH /api/integrations/slack/channel` route.

**Option B**: Auto-join a `#atlas-qa` channel if it exists, or prompt channel selection on the settings page.

**Recommended**: Option A.

New API route: `app/api/integrations/slack/channel/route.ts`
- **GET**: List available channels for the project's Slack integration.
- **PATCH**: Update `config.channel_id` on the integration row.

### 9.2 Add observability context to Slack reports

**File**: `runner/reporter.py`

Update `send_slack_report` to include sections for:

- **Sentry errors detected**: List new Sentry issues triggered during the test run, with severity and frequency.
- **LLM trace failures**: LangSmith/Braintrust errors or low-scoring evaluations detected during test execution.
- **PostHog exceptions**: Frontend errors captured by PostHog during the test window.

Add new Block Kit sections:

```python
# Sentry errors
if observability_data.get("sentry_errors"):
    blocks.append({"type": "divider"})
    sentry_text = "*🔴 Sentry Errors Detected:*\n"
    for err in observability_data["sentry_errors"][:5]:
        sentry_text += f"• *{err['title']}* ({err['level']}) — {err['count']}x\n"
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": sentry_text}})

# LLM trace failures
llm_errors = (
    observability_data.get("langsmith_errors", []) +
    observability_data.get("braintrust_errors", [])
)
if llm_errors:
    blocks.append({"type": "divider"})
    llm_text = "*🤖 LLM Trace Failures:*\n"
    for err in llm_errors[:5]:
        llm_text += f"• *{err.get('name', 'Unknown')}*: {err.get('error', 'Failed')}\n"
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": llm_text}})
```

### 9.3 Update the AI summary prompt

**File**: `runner/reporter.py` — `generate_ai_summary`

Include observability data in the Claude prompt so the AI analysis covers Sentry errors, LLM failures, and PostHog exceptions — not just QA test pass/fail.

---

## 10. Phase 9 — New Project Flow Overhaul

### 10.1 Redesign the creation flow as a multi-step wizard

Replace the single long form with a guided wizard:

**Step 1: Basic Info**
- Project name (required)
- App URL (required)
- Auth credentials (optional)

**Step 2: Connect GitHub** (post-creation)
- "Connect GitHub" button → GitHub App install flow → repo selector
- Or "Skip for now"

**Step 3: Connect Observability** (post-creation)
- Cards for each platform: PostHog, Sentry, LangSmith, Braintrust
- Each card: click to expand → enter credentials → validate → save
- Or "Skip, I'll set these up later"

**Step 4: Connect Slack** (post-creation)
- "Connect Slack" button → OAuth → channel picker
- Or "Skip"

### 10.2 Implementation approach

**File**: `app/(dashboard)/projects/new/page.tsx`

Replace with a multi-step component. On Step 1 submission:
1. POST to `/api/projects` to create the project.
2. Navigate to Step 2 with the new `projectId`.
3. Each subsequent step calls the relevant `/api/integrations/*/connect` route.

Alternatively, create the project on Step 1, then redirect to `/projects/[projectId]/setup` — a dedicated setup page that shows the integration wizard.

**New file**: `app/(dashboard)/projects/[projectId]/setup/page.tsx`

This keeps the new-project form simple and puts integration setup on a dedicated page that can also be accessed from settings.

### 10.3 Update the projects API

**File**: `app/api/projects/route.ts`

No changes needed for the POST handler — it already creates the project with just `name` and `app_url`. The integration connections happen via their own routes after project creation.

Remove the dead fields (`github_repo`, `posthog_key`, `sentry_dsn`, `langsmith_key`) from the frontend form since they were never actually persisted.

---

## 11. Phase 10 — Settings Page & Integration Management

### 11.1 Redesign the settings page

**File**: `app/(dashboard)/projects/[projectId]/settings/page.tsx`

Replace the bare list with interactive integration cards:

```
┌─────────────────────────────────────────────┐
│  GitHub                         ✅ Connected │
│  Repos: acme/web, acme/api                  │
│  [Manage repos]  [Disconnect]               │
├─────────────────────────────────────────────┤
│  PostHog                        ✅ Connected │
│  Project: 12345                             │
│  [Disconnect]                               │
├─────────────────────────────────────────────┤
│  Sentry                      ⬚ Not connected│
│  [Connect Sentry]                           │
├─────────────────────────────────────────────┤
│  LangSmith                   ⬚ Not connected│
│  [Connect LangSmith]                        │
├─────────────────────────────────────────────┤
│  Braintrust                  ⬚ Not connected│
│  [Connect Braintrust]                       │
├─────────────────────────────────────────────┤
│  Slack                          ✅ Connected │
│  Workspace: Acme Inc  Channel: #qa-alerts   │
│  [Change channel]  [Disconnect]             │
└─────────────────────────────────────────────┘
```

### 11.2 Add disconnect functionality

**File**: new `app/api/integrations/[integrationId]/route.ts`

- **DELETE**: Set `status = 'disconnected'` on the integration row (soft delete) or delete the row entirely.
- **PATCH**: Update config fields (e.g., change Slack channel, update repo selection).

### 11.3 Integration status API

**File**: new `app/api/projects/[projectId]/integrations/route.ts`

- **GET**: Return all integrations for a project with their status and sanitized config (strip encrypted fields, return only display-safe metadata like team name, project slug, repo names).

---

## 12. Environment Variables & Secrets

### New variables required

Add to `.env.example`:

```bash
# Sentry (internal integration for API access)
# Not needed at platform level — users provide their own auth tokens.
# If you want to offer OAuth instead of auth tokens:
# SENTRY_CLIENT_ID=
# SENTRY_CLIENT_SECRET=

# LangSmith — no platform secrets needed; users provide their own API keys.

# Braintrust — no platform secrets needed; users provide their own API keys.

# GitHub App
GITHUB_APP_SLUG=atlas-qa
# (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY already exist)
# For webhook verification:
GITHUB_WEBHOOK_SECRET=
```

### Existing variables (no changes)

```bash
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
ENCRYPTION_KEY=
```

---

## 13. Security Considerations

### 13.1 Secret storage

- **All API keys and tokens** must be encrypted with AES-256-GCM via `lib/encryption.ts` / `runner/encryption.py` before storing in the `config` JSONB column.
- **Never** return encrypted values to the frontend. The integrations status API should strip `*_encrypted` fields and return only display metadata.

### 13.2 Token scoping

- **Sentry**: Recommend users create tokens with minimal scopes: `project:read`, `event:read`, `issue:read`.
- **LangSmith**: API keys are workspace-scoped; document that read-only keys are sufficient.
- **Braintrust**: API keys are org-scoped; document that read-only access is sufficient.
- **GitHub**: The GitHub App installation already scopes access to user-selected repos.

### 13.3 Credential validation

Every connect route **must** validate credentials against the external API before storing them. This catches typos, expired tokens, and insufficient permissions early.

### 13.4 Row-Level Security

The existing RLS policies on `integrations` ensure users can only read/write integrations for projects belonging to their organization. No changes needed.

### 13.5 Webhook verification

The GitHub webhook route must verify the `X-Hub-Signature-256` header using `GITHUB_WEBHOOK_SECRET` to prevent spoofed payloads.

---

## 14. Appendix: Integration Config Schemas

### GitHub

```json
{
  "installation_id": 12345678,
  "setup_action": "install",
  "repos": [
    { "full_name": "acme/web", "private": true, "default_branch": "main" },
    { "full_name": "acme/api", "private": true, "default_branch": "main" }
  ]
}
```

### PostHog

```json
{
  "api_key_encrypted": "iv:tag:cipher",
  "posthog_project_id": "12345",
  "api_host": "https://us.posthog.com"
}
```

### Sentry

```json
{
  "auth_token_encrypted": "iv:tag:cipher",
  "organization_slug": "my-org",
  "project_slug": "my-project"
}
```

### LangSmith

```json
{
  "api_key_encrypted": "iv:tag:cipher",
  "project_name": "default",
  "api_url": "https://api.smith.langchain.com"
}
```

### Braintrust

```json
{
  "api_key_encrypted": "iv:tag:cipher",
  "project_name": "my-project",
  "api_url": "https://api.braintrust.dev"
}
```

### Slack

```json
{
  "bot_token_encrypted": "iv:tag:cipher",
  "team_id": "T01234567",
  "team_name": "Acme Inc",
  "bot_user_id": "U01234567",
  "channel_id": "C01234567",
  "channel_name": "qa-alerts"
}
```

---

## Execution Order & Dependencies

```
Phase 1 (DB)
  └── Phase 2 (GitHub) ─── can start immediately after Phase 1
  └── Phase 3 (Sentry) ─── can start immediately after Phase 1
  └── Phase 4 (PostHog) ── can start immediately (no DB changes needed)
  └── Phase 5 (LangSmith)  can start immediately after Phase 1
  └── Phase 6 (Braintrust)  can start immediately after Phase 1
       │
       └── All above complete
            └── Phase 7 (Runner observability) ── depends on all client libs
            └── Phase 8 (Slack enrichment) ────── depends on Phase 7
            └── Phase 9 (New project flow) ────── depends on all connect routes
            └── Phase 10 (Settings page) ─────── depends on all connect routes
```

Phases 2–6 are independent and can be worked on in parallel. Phases 7–10 depend on the client libraries and connect routes from earlier phases.
