# Atlas — Implementation Plan

## Executive Summary

Atlas is a multi-tenant SaaS platform that provides autonomous, AI-driven browser-based QA testing for engineering teams. Customers connect their production/staging URL, GitHub repo, and PostHog project. On every deploy (or on a schedule), Atlas spins up an isolated cloud browser, authenticates into the customer's app, runs AI-planned test flows derived from real user behavior and recent code changes, and reports results to Slack.

---

## Analysis of the Original Plan

### Strengths

1. **Tech stack is well-chosen** — Next.js 16, Supabase, Browserbase, Stagehand v3, and Claude form a cohesive, modern stack with minimal operational overhead.
2. **Data model is solid** — Multi-tenant org structure with RLS, clear separation of projects/integrations/templates/runs/results.
3. **GitHub Actions as compute** — Pragmatic solution for long-running test execution without managing infrastructure. Vercel handles the web app; GHA handles the heavy compute.
4. **Security-first credential handling** — AES-256-GCM encryption for passwords, RLS with security-definer functions, webhook signature verification.
5. **AgentMail for 2FA** — Elegant solution for handling email-based verification during automated auth flows.

### Refinements & Additions

1. **Stagehand `agent()` mode** — The original plan uses individual `act()`/`observe()` calls for test execution. Stagehand v3 now has an `agent()` method that can autonomously execute multi-step workflows. We should use `agent()` for test flow execution with `act()`/`observe()` as fallbacks. This makes test templates simpler (natural language task descriptions instead of rigid step sequences) and execution more robust against UI changes.

2. **Add `test_plans` table** — Store the AI-generated plan for each run so we have an audit trail of what was planned vs. what was executed. This is invaluable for debugging and for users to understand why certain tests were chosen.

3. **Add `schedules` to projects** — The original plan mentions scheduled/cron runs but doesn't model them. Add a `cron_schedule` field to projects (e.g., `"0 */6 * * *"` for every 6 hours) and use Vercel Cron to trigger them.

4. **Retry logic** — Flaky tests are the #1 frustration in QA. Add a configurable `max_retries` (default: 1) per template, and track `attempt_number` on results.

5. **Real-time progress** — Use Supabase Realtime to push test execution progress to the dashboard so users can watch runs in progress, not just see results after completion.

6. **Parallel test execution** — Run independent test flows concurrently within a single GHA job using Promise.allSettled to reduce total run time.

7. **Regression detection** — Compare current run results against the previous run for the same project. New failures = regressions. Highlight these prominently in the Slack report.

---

## Open Design Questions + Decisions

These are questions that surfaced during analysis. Each includes the decision we'll move forward with.

### Q1: Should we use Stagehand `agent()` or manual `act()`/`observe()` chains?

**Decision: Hybrid approach.** Use `agent()` as the primary execution mode for test flows — it's more resilient to UI changes and requires simpler template definitions. Fall back to `act()`/`observe()` for the authentication flow where we need precise control (entering specific credentials, handling 2FA). Template `steps` become high-level natural language task descriptions that `agent()` executes autonomously.

### Q2: Should we support OAuth/SSO auth flows, or just email+password+2FA?

**Decision: Email+password+2FA for v1.** OAuth/SSO flows are wildly varied across providers. We'll use Stagehand's `agent()` mode which can handle visual OAuth redirects in many cases, but we won't explicitly build OAuth support into the auth framework. Document it as a v2 feature.

### Q3: AI-generated templates from PostHog data — from the start, or manual only?

**Decision: Both from the start.** AI template generation is a core differentiator. The test planner already analyzes PostHog data; we'll have it generate template suggestions that users can review, edit, and activate. Manual creation is also supported.

### Q4: How should test templates be structured?

**Decision: Natural language with optional structured hints.** Templates store a `goal` (natural language description of what to test, e.g., "Search for a product, add it to cart, proceed to checkout") plus optional `hints` (specific selectors, URLs, or data to use). The `agent()` method executes the goal; hints provide guidance without being brittle step-by-step scripts.

### Q5: Concurrency model for test execution within a run?

**Decision: Configurable parallelism.** Default to sequential execution (one flow at a time in one browser). Support a `parallel` flag on the run that opens multiple Browserbase sessions. Sequential is safer for v1; parallel is an optimization we can enable per-project.

---

## Finalized Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript, strict mode) |
| Database / Auth | Supabase (Postgres, Auth, RLS, Realtime, Storage) |
| Browser infra | Browserbase (cloud browser sessions) |
| Browser automation | Stagehand v3 (`agent()` + `act()`/`observe()`/`extract()`) |
| Email for 2FA | AgentMail (programmatic inbox per project) |
| LLM | Claude API via `@anthropic-ai/sdk` (test planning + flow reasoning) |
| Integrations | GitHub App (webhooks + commits), PostHog API (sessions), Slack (OAuth + reporting) |
| Deployment | Vercel (web app + API routes + cron) |
| Job runner | GitHub Actions `workflow_dispatch` for long-running test execution |
| UI | Tailwind CSS + shadcn/ui components |
| Validation | Zod (API input validation + Stagehand extract schemas) |

---

## Finalized Data Model

```sql
-- Enums
CREATE TYPE org_role AS ENUM ('owner', 'member');
CREATE TYPE integration_type AS ENUM ('github', 'posthog', 'slack');
CREATE TYPE integration_status AS ENUM ('active', 'disconnected');
CREATE TYPE template_source AS ENUM ('manual', 'ai_generated');
CREATE TYPE run_trigger AS ENUM ('deploy', 'manual', 'scheduled');
CREATE TYPE run_status AS ENUM ('pending', 'planning', 'running', 'completed', 'failed');
CREATE TYPE result_status AS ENUM ('passed', 'failed', 'error', 'skipped');

-- Organizations (tenants)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  created_by UUID NOT NULL REFERENCES auth.users,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organization members
CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  role org_role DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Projects: each app a customer wants to test
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name TEXT NOT NULL,
  app_url TEXT NOT NULL,
  auth_email TEXT,
  auth_password_encrypted TEXT,
  agentmail_inbox_id TEXT,
  agentmail_inbox_address TEXT,
  cron_schedule TEXT,                          -- e.g. "0 */6 * * *", NULL = no schedule
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Integration connections per project
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects ON DELETE CASCADE,
  type integration_type NOT NULL,
  config JSONB NOT NULL,
  status integration_status DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, type)
);

-- Test templates: parameterized test flows
CREATE TABLE test_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  goal TEXT NOT NULL,                          -- natural language goal for agent()
  hints JSONB DEFAULT '{}',                    -- optional: selectors, URLs, test data
  source template_source DEFAULT 'manual',
  is_active BOOLEAN DEFAULT true,
  max_retries INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Test runs: each execution batch
CREATE TABLE test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects ON DELETE CASCADE,
  trigger run_trigger NOT NULL,
  trigger_ref TEXT,                            -- commit SHA or deploy ID
  status run_status DEFAULT 'pending',
  plan JSONB,                                  -- the AI-generated test plan
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  summary JSONB,                               -- aggregated results
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual test results within a run
CREATE TABLE test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id UUID NOT NULL REFERENCES test_runs ON DELETE CASCADE,
  test_template_id UUID REFERENCES test_templates,
  status result_status NOT NULL,
  attempt_number INT DEFAULT 1,
  duration_ms INT,
  error_message TEXT,
  screenshots TEXT[],                          -- Supabase Storage URLs
  console_logs JSONB,
  network_errors JSONB,
  agent_reasoning TEXT,                        -- the agent's step-by-step reasoning log
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Key changes from original:
- `test_templates.steps` replaced with `goal` (natural language) + `hints` (structured guidance) — aligns with `agent()` execution model
- Added `test_templates.max_retries`
- Added `test_runs.plan` to store the AI-generated test plan
- Added `test_results.attempt_number` for retry tracking
- Added `test_results.agent_reasoning` to capture the agent's thought process
- Added `projects.cron_schedule` for scheduled runs

---

## RLS Security Model

```sql
-- Helper functions
CREATE OR REPLACE FUNCTION get_user_org_ids()
RETURNS SETOF UUID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM org_members WHERE user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION is_org_owner(target_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = target_org_id AND user_id = auth.uid() AND role = 'owner'
  )
$$;
```

All org-scoped tables get SELECT/INSERT/UPDATE/DELETE policies gated by `org_id IN (SELECT get_user_org_ids())`. Owner-only destructive operations gated by `is_org_owner(org_id)`.

---

## Architecture Flow (Refined)

```
Trigger (GitHub deploy webhook / manual / cron schedule)
  │
  ▼
POST /api/webhooks/github (or POST /api/runs with manual trigger)
  → Verify webhook signature (X-Hub-Signature-256)
  → Look up project by repo (from integrations table)
  → Create test_run record (status: 'pending')
  → Dispatch GitHub Actions workflow via workflow_dispatch
  │
  ▼
GitHub Actions Runner (runner/execute.ts)
  │
  ├─ 1. LOAD CONTEXT
  │    → Fetch project, integrations, active templates from Supabase
  │    → Decrypt credentials
  │    → Update test_run status → 'planning'
  │
  ├─ 2. TEST PLANNER (Claude API)
  │    → Fetch recent commits + diffs via GitHub API
  │    → Fetch recent PostHog sessions, error events, top pages
  │    → Analyze: what changed? What do users do most? Where are errors?
  │    → Select & prioritize templates, generate parameters
  │    → Store plan in test_run.plan
  │    → Optionally generate new template suggestions
  │    → Update test_run status → 'running'
  │
  ├─ 3. TEST EXECUTOR (Stagehand agent() + Browserbase)
  │    For each selected template (sequentially or in parallel):
  │      a. Create Browserbase session
  │      b. Initialize Stagehand v3 (env: BROWSERBASE, model: claude)
  │      c. AUTH FLOW (act/observe with precise control):
  │         → Navigate to app login URL
  │         → Enter email + password via act()
  │         → If 2FA detected via observe():
  │           → Poll AgentMail inbox for verification email
  │           → Extract OTP code
  │           → Enter code via act()
  │      d. EXECUTE TEST via agent():
  │         → Pass template goal + hints as the agent task
  │         → Agent autonomously navigates, interacts, validates
  │         → Capture screenshots at key moments
  │         → Collect console logs + network errors
  │      e. Determine pass/fail based on agent completion + error signals
  │      f. On failure: retry up to max_retries times
  │      g. Write test_result to Supabase (with agent_reasoning)
  │      h. Destroy Browserbase session
  │
  └─ 4. REPORTER
       → Aggregate pass/fail counts
       → Diff against previous run (new failures = regressions)
       → Upload failure screenshots to Supabase Storage
       → Generate bug fix recommendations via Claude
       → Format Slack Block Kit message
       → Post to customer's connected Slack channel
       → Update test_run (status: 'completed', summary JSONB)
```

---

## Directory Structure (Finalized)

```
atlas/
├── app/
│   ├── (dashboard)/
│   │   ├── layout.tsx                    # Authenticated layout, org context, sidebar nav
│   │   ├── projects/
│   │   │   ├── page.tsx                  # Project list
│   │   │   ├── new/page.tsx              # Create project wizard
│   │   │   └── [projectId]/
│   │   │       ├── page.tsx              # Project overview (pass rate, recent runs)
│   │   │       ├── settings/page.tsx     # URL, credentials, integrations
│   │   │       ├── templates/page.tsx    # Manage test templates
│   │   │       └── runs/
│   │   │           ├── page.tsx          # Run history
│   │   │           └── [runId]/page.tsx  # Run detail with per-test results
│   │   └── settings/
│   │       └── page.tsx                  # Org settings, members
│   ├── (public)/
│   │   ├── page.tsx                      # Landing page
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── api/
│   │   ├── webhooks/
│   │   │   └── github/route.ts           # GitHub push/deploy webhooks
│   │   ├── integrations/
│   │   │   ├── github/
│   │   │   │   ├── install/route.ts
│   │   │   │   └── callback/route.ts
│   │   │   ├── posthog/
│   │   │   │   └── connect/route.ts
│   │   │   └── slack/
│   │   │       ├── authorize/route.ts
│   │   │       └── callback/route.ts
│   │   ├── projects/
│   │   │   ├── route.ts                  # List + create projects
│   │   │   └── [projectId]/route.ts      # Get + update + delete project
│   │   ├── templates/
│   │   │   ├── route.ts                  # List + create templates
│   │   │   └── [templateId]/route.ts     # Get + update + delete template
│   │   ├── runs/
│   │   │   ├── route.ts                  # List runs + manual trigger
│   │   │   └── [runId]/route.ts          # Run detail + results
│   │   └── cron/
│   │       └── scheduled-runs/route.ts   # Vercel Cron handler
│   └── layout.tsx                        # Root layout (fonts, providers)
├── components/
│   ├── ui/                               # shadcn/ui primitives
│   ├── dashboard/                        # Dashboard-specific components
│   │   ├── sidebar.tsx
│   │   ├── project-card.tsx
│   │   ├── run-status-badge.tsx
│   │   ├── test-result-row.tsx
│   │   └── pass-rate-chart.tsx
│   ├── forms/                            # Form components
│   │   ├── project-form.tsx
│   │   ├── template-form.tsx
│   │   └── integration-connect.tsx
│   └── landing/                          # Landing page components
├── lib/
│   ├── supabase/
│   │   ├── client.ts                     # Browser client
│   │   ├── server.ts                     # Server client (cookies-based)
│   │   ├── service-role.ts               # Service role client (bypasses RLS)
│   │   └── middleware.ts                  # Session refresh helper
│   ├── agentmail.ts                      # AgentMail client, inbox provisioning, 2FA polling
│   ├── browserbase.ts                    # Session create/connect/destroy
│   ├── github.ts                         # GitHub App auth, commit/diff fetching
│   ├── posthog.ts                        # PostHog API client (sessions, events, trends)
│   ├── slack.ts                          # Slack OAuth + Block Kit message posting
│   ├── encryption.ts                     # AES-256-GCM encrypt/decrypt
│   ├── test-planner.ts                   # Claude API — analyze data → prioritized test plan
│   ├── test-executor.ts                  # Stagehand orchestration — auth + agent() execution
│   └── reporter.ts                       # Aggregate results, regression detection, Slack report
├── runner/
│   └── execute.ts                        # GHA entry point — load → plan → execute → report
├── middleware.ts                          # Next.js middleware — auth redirects, route protection
├── .github/
│   └── workflows/
│       └── test-run.yml                  # workflow_dispatch for test execution
├── supabase/
│   └── migrations/
│       ├── 001_create_enums.sql
│       ├── 002_create_organizations.sql
│       ├── 003_create_projects.sql
│       ├── 004_create_integrations.sql
│       ├── 005_create_test_templates.sql
│       ├── 006_create_test_runs.sql
│       ├── 007_create_test_results.sql
│       └── 008_rls_policies.sql
├── types/
│   ├── database.ts                       # Generated Supabase types
│   ├── index.ts                          # Shared app types
│   └── test-plan.ts                      # Test plan schema types
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── components.json                       # shadcn/ui config
└── .env.example
```

---

## Implementation Phases

### Phase 1: Project Scaffolding + Data Model

**Goal:** Bootable Next.js app with Supabase schema, auth, and base UI shell.

#### Steps:

1. **Initialize Next.js 16 project**
   ```bash
   npx create-next-app@latest . --typescript --tailwind --app --src-dir=false
   ```

2. **Install core dependencies**
   ```bash
   npm install @supabase/supabase-js @supabase/ssr
   npm install @anthropic-ai/sdk agentmail @browserbasehq/sdk @browserbasehq/stagehand
   npm install @octokit/app @octokit/rest
   npm install zod
   npm install -D supabase
   ```

3. **Install UI dependencies**
   ```bash
   npx shadcn@latest init
   npx shadcn@latest add button card input label textarea select badge tabs table dialog sheet dropdown-menu avatar separator toast
   ```

4. **Create `.env.example`** with all required environment variables

5. **Write all 8 migration files** — enums, organizations, projects, integrations, test_templates, test_runs, test_results, RLS policies

6. **Build Supabase client helpers**
   - `lib/supabase/client.ts` — browser client using `createBrowserClient`
   - `lib/supabase/server.ts` — server client using `createServerClient` with cookies
   - `lib/supabase/service-role.ts` — service role client for runner (bypasses RLS)
   - `lib/supabase/middleware.ts` — session refresh helper

7. **Implement `middleware.ts`** — protect dashboard routes, redirect unauthenticated users, refresh sessions

8. **Build auth pages**
   - `app/(public)/login/page.tsx` — email+password login
   - `app/(public)/signup/page.tsx` — signup + org creation
   - `app/(public)/page.tsx` — landing page (simple hero + CTA)

9. **Build dashboard layout**
   - `app/(dashboard)/layout.tsx` — sidebar navigation, org context provider
   - Sidebar with: Projects, Settings navigation

10. **Build org settings page**
    - `app/(dashboard)/settings/page.tsx` — org name, member management

#### Deliverable: App boots, users can sign up, log in, see empty dashboard.

---

### Phase 2: Project CRUD + Integration Connections

**Goal:** Users can create projects, configure app URLs and credentials, connect GitHub/PostHog/Slack.

#### Steps:

1. **Project API routes**
   - `app/api/projects/route.ts` — GET (list) + POST (create)
   - `app/api/projects/[projectId]/route.ts` — GET + PATCH + DELETE
   - On create: provision AgentMail inbox, store inbox ID + address

2. **`lib/encryption.ts`** — AES-256-GCM encrypt/decrypt for credentials

3. **`lib/agentmail.ts`** — AgentMail client wrapper
   - `createInbox(projectSlug)` — provision inbox
   - `poll2FACode(inboxId, opts)` — poll for verification code with timeout

4. **Project UI pages**
   - `app/(dashboard)/projects/page.tsx` — project list with cards
   - `app/(dashboard)/projects/new/page.tsx` — create project form (name, app URL, test account credentials)
   - `app/(dashboard)/projects/[projectId]/page.tsx` — project overview (placeholder, will show runs later)
   - `app/(dashboard)/projects/[projectId]/settings/page.tsx` — edit URL, credentials, view integration status

5. **GitHub App integration**
   - `lib/github.ts` — GitHub App JWT auth, installation token exchange, commit/diff fetching
   - `app/api/integrations/github/install/route.ts` — redirect to GitHub App install page
   - `app/api/integrations/github/callback/route.ts` — handle installation callback, store `installation_id`
   - `app/api/webhooks/github/route.ts` — verify `X-Hub-Signature-256`, handle `push` events

6. **PostHog integration**
   - `lib/posthog.ts` — PostHog API client (validate key, fetch sessions, fetch events)
   - `app/api/integrations/posthog/connect/route.ts` — validate API key + project ID, store encrypted

7. **Slack integration**
   - `lib/slack.ts` — Slack OAuth helpers, `chat.postMessage` wrapper, Block Kit message builder
   - `app/api/integrations/slack/authorize/route.ts` — build OAuth URL, redirect
   - `app/api/integrations/slack/callback/route.ts` — exchange code for bot token, store encrypted

8. **Integration settings UI** — connect/disconnect buttons for each integration, status indicators

#### Deliverable: Users can create projects, enter credentials, connect all three integrations.

---

### Phase 3: Test Templates

**Goal:** Users can create, edit, and manage test templates. AI can suggest templates.

#### Steps:

1. **Template API routes**
   - `app/api/templates/route.ts` — GET (list by project) + POST (create)
   - `app/api/templates/[templateId]/route.ts` — GET + PATCH + DELETE

2. **Template UI page**
   - `app/(dashboard)/projects/[projectId]/templates/page.tsx`
   - List of templates with name, goal, source (manual/AI), active toggle
   - Create/edit dialog with: name, description, goal (textarea), hints (JSON editor or structured form)
   - "Generate with AI" button that calls the test planner to suggest templates based on PostHog data

3. **Template Zod schemas** — validate template creation/update payloads

4. **Seed templates** — create a set of common template patterns:
   - "Smoke test: login and verify dashboard loads"
   - "Search flow: search for [query], verify results appear"
   - "Form submission: fill out [form], submit, verify success"

#### Deliverable: Users can manage test templates with a clean UI.

---

### Phase 4: Test Planner (Claude AI)

**Goal:** Given recent commits + PostHog data + available templates, produce a prioritized test plan.

#### Steps:

1. **`lib/github.ts` enhancements**
   - `getRecentCommits(installationId, repo, since)` — fetch last N commits with diffs
   - `getCommitDiff(installationId, repo, sha)` — fetch full diff for a specific commit

2. **`lib/posthog.ts` enhancements**
   - `getRecentSessions(apiKey, projectId, opts)` — fetch recent session recordings metadata
   - `getTopPages(apiKey, projectId, opts)` — fetch most-visited pages
   - `getErrorEvents(apiKey, projectId, opts)` — fetch `$exception` and rage-click events

3. **`lib/test-planner.ts`** — core planning logic
   - `createTestPlan(context)` — calls Claude API with structured prompt
   - Input: recent commits, PostHog session data, available templates, project config
   - Output: ordered list of `{ templateId, priority, parameters, reasoning }`
   - Also outputs: suggested new templates if PostHog reveals untested flows
   - Uses Zod to validate Claude's structured output

4. **Test planner prompt** (refined):
   ```
   You are Atlas, an AI QA test planner for web applications.

   Given:
   1. Recent git commits (diffs + messages) — what code changed
   2. PostHog analytics (top pages, user flows, error events, rage clicks) — what real users do
   3. Available test templates with goals and descriptions

   Your job: select which templates to run, prioritize them, and provide runtime parameters.

   Prioritization rules:
   - HIGHEST: Templates covering code areas that changed in recent commits
   - HIGH: Templates covering flows where PostHog shows errors or rage clicks
   - MEDIUM: Templates covering the most-exercised user flows (by session frequency)
   - ALWAYS: Include at least one smoke test (auth + basic navigation)

   For each selected template, output:
   {
     "template_id": "uuid",
     "priority": 1,
     "parameters": { ... },
     "reasoning": "One sentence explaining why"
   }

   Also output up to 3 suggested new templates for flows you see in PostHog
   data that aren't covered by existing templates.
   ```

#### Deliverable: Test planner takes context and produces a validated, prioritized test plan.

---

### Phase 5: Test Executor (Stagehand + Browserbase)

**Goal:** Execute test flows in isolated cloud browsers with authentication, 2FA handling, and evidence capture.

#### Steps:

1. **`lib/browserbase.ts`**
   - `createSession(opts)` — create Browserbase session with project ID
   - `destroySession(sessionId)` — clean up session

2. **`lib/test-executor.ts`** — core execution engine
   - `authenticateApp(stagehand, project)` — handle login + 2FA via act/observe + AgentMail
   - `executeTestFlow(stagehand, template, parameters)` — run test via agent() with goal + hints
   - `captureEvidence(page)` — screenshots, console logs, network errors
   - `runSingleTest(project, template, parameters)` — full lifecycle: create session → auth → execute → capture → cleanup
   - `runTestPlan(project, plan)` — iterate through planned tests with retry logic

3. **Authentication flow implementation:**
   ```typescript
   async function authenticateApp(stagehand: Stagehand, project: Project) {
     // Navigate to login
     await stagehand.act(`navigate to ${project.appUrl} and find the login page`);

     // Enter credentials
     await stagehand.act(`enter "${project.authEmail}" into the email field`);
     await stagehand.act(`enter the password and submit the login form`);

     // Check for 2FA
     const needs2FA = await stagehand.observe("is there a verification code or 2FA input visible?");
     if (needs2FA.length > 0) {
       const code = await poll2FACode(project.agentmailInboxId, { timeout: 60_000 });
       await stagehand.act(`enter verification code: ${code} and submit`);
     }

     // Verify auth succeeded
     const authCheck = await stagehand.observe("is there a dashboard or authenticated content visible?");
     if (authCheck.length === 0) {
       throw new Error("Authentication failed — no authenticated content detected");
     }
   }
   ```

4. **Test execution via agent():**
   ```typescript
   async function executeTestFlow(stagehand: Stagehand, template: TestTemplate, params: Record<string, any>) {
     const agent = stagehand.agent({
       model: "anthropic/claude-sonnet-4-20250514",
       systemPrompt: `You are testing a web application. Your goal: ${template.goal}.
         ${template.hints ? `Hints: ${JSON.stringify(template.hints)}` : ''}
         ${params ? `Parameters: ${JSON.stringify(params)}` : ''}
         Navigate carefully, verify each step succeeds, and report any errors or unexpected behavior.`,
       maxSteps: 50,
     });

     const result = await agent.execute(template.goal);
     return result;
   }
   ```

5. **Evidence capture:**
   - Screenshot on each major navigation event
   - Screenshot on test completion (pass or fail)
   - Capture browser console logs (errors + warnings)
   - Capture failed network requests (4xx/5xx)

6. **Retry logic:**
   - On test failure, retry up to `template.max_retries` times
   - Fresh browser session for each retry
   - Track `attempt_number` on each result

#### Deliverable: Full test execution pipeline that can auth, run flows, and capture evidence.

---

### Phase 6: Runner Entry Point + GitHub Actions

**Goal:** Wire everything together — the GHA workflow dispatches to `runner/execute.ts` which orchestrates the full pipeline.

#### Steps:

1. **`runner/execute.ts`** — end-to-end orchestrator
   ```
   Load project + integrations from Supabase (service role)
   → Decrypt credentials
   → Update run status: 'planning'
   → Run test planner (fetch commits + PostHog data → Claude → plan)
   → Store plan on test_run record
   → Update run status: 'running'
   → Execute each test in plan (Stagehand + Browserbase)
   → Write results to Supabase
   → Run reporter (aggregate, detect regressions, upload screenshots)
   → Post Slack report
   → Update run status: 'completed' (or 'failed')
   ```

2. **`.github/workflows/test-run.yml`**
   - `workflow_dispatch` trigger with `test_run_id` and `project_id` inputs
   - Checkout, setup Node 22, `npm ci`, run `npx tsx runner/execute.ts`
   - All secrets passed as environment variables
   - 30-minute timeout

3. **Webhook → GHA dispatch:**
   - `app/api/webhooks/github/route.ts` creates the test_run record, then calls `octokit.actions.createWorkflowDispatch()` to trigger the GHA workflow

4. **Manual trigger:**
   - `app/api/runs/route.ts` POST handler creates test_run + dispatches GHA workflow

5. **Scheduled trigger:**
   - `app/api/cron/scheduled-runs/route.ts` — Vercel Cron handler that finds projects with active cron schedules, creates test_runs, dispatches GHA workflows
   - `vercel.json` cron config: check every 15 minutes, evaluate which projects are due

#### Deliverable: End-to-end pipeline works — trigger a run manually or via webhook, tests execute in GHA, results appear in Supabase.

---

### Phase 7: Reporting + Slack

**Goal:** Rich test reports posted to Slack with regression detection and recommendations.

#### Steps:

1. **`lib/reporter.ts`**
   - `aggregateResults(runId)` — fetch all results, compute pass/fail/error counts, total duration
   - `detectRegressions(projectId, currentRunId)` — compare against previous run, find new failures
   - `generateRecommendations(results, commits)` — Claude API call to generate bug fix suggestions
   - `uploadScreenshots(results)` — upload failure screenshots to Supabase Storage, return public URLs
   - `buildReport(run, results, regressions, recommendations)` — compile full report object

2. **`lib/slack.ts` enhancements**
   - `formatTestRunBlocks(report)` — Slack Block Kit message builder
     - Header: "Atlas Test Run #X — [PROJECT] — PASS/FAIL"
     - Summary section: pass/fail counts, duration, trigger info
     - Regression alerts: new failures highlighted in red
     - Per-test results: expandable sections with status, duration, error messages
     - Recommendations: AI-generated fix suggestions
     - Screenshot links for failed tests
     - Link to full report in Atlas dashboard
   - `postReport(botToken, channelId, blocks)` — send the message

3. **Report storage:**
   - `test_runs.summary` JSONB stores the full aggregated report
   - Screenshots in Supabase Storage under `screenshots/{runId}/{resultId}/`

#### Deliverable: Detailed, actionable Slack reports with regression detection.

---

### Phase 8: Dashboard Pages

**Goal:** Polished dashboard for viewing projects, runs, results, and managing settings.

#### Steps:

1. **Project overview page** (`app/(dashboard)/projects/[projectId]/page.tsx`)
   - Pass rate chart (last 30 runs)
   - Recent runs list with status badges
   - Integration connection status
   - Quick actions: trigger manual run, view templates

2. **Run history page** (`app/(dashboard)/projects/[projectId]/runs/page.tsx`)
   - Table of all runs: status, trigger, commit ref, pass/fail counts, duration, timestamp
   - Filter by status, trigger type
   - Click to view run details

3. **Run detail page** (`app/(dashboard)/projects/[projectId]/runs/[runId]/page.tsx`)
   - Run metadata: trigger, commit SHA, duration, timestamps
   - Test plan: what the AI decided to test and why
   - Per-test results: status, duration, error messages, screenshots
   - Agent reasoning: expand to see the agent's step-by-step thought process
   - Regression indicators: highlight tests that newly failed vs. previous run

4. **Real-time updates** — use Supabase Realtime to subscribe to test_run status changes, update UI without polling

#### Deliverable: Full dashboard with real-time test monitoring.

---

### Phase 9: Polish + Hardening

**Goal:** Production-ready quality, error handling, edge cases.

#### Steps:

1. **Error handling throughout:**
   - Graceful degradation when integrations are disconnected
   - Timeout handling in test execution (per-test and per-run timeouts)
   - Clear error messages when credentials are invalid

2. **Input validation:**
   - Zod schemas for all API endpoints
   - URL validation for app_url
   - Cron expression validation for schedules

3. **Logging + observability:**
   - Structured logging in runner/execute.ts
   - Run duration tracking
   - Error categorization (auth failure vs. test failure vs. infrastructure error)

4. **Security hardening:**
   - Rate limiting on API routes
   - Webhook signature verification
   - CORS configuration
   - Encrypted credential rotation support

5. **UI polish:**
   - Loading states and skeletons
   - Empty states with helpful CTAs
   - Toast notifications for async operations
   - Mobile-responsive layout

#### Deliverable: Production-ready application.

---

## Environment Variables (.env.example)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Encryption
ENCRYPTION_KEY=                    # 64-char hex string (32 bytes)

# Browserbase
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=

# AgentMail
AGENTMAIL_API_KEY=

# Claude API (for test planner + agent reasoning)
ANTHROPIC_API_KEY=

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=            # PEM format, base64-encoded
GITHUB_WEBHOOK_SECRET=

# Slack
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## Key External Service Documentation

| Service | Docs | Key APIs |
|---|---|---|
| Stagehand v3 | docs.stagehand.dev | `agent()`, `act()`, `observe()`, `extract()` |
| Browserbase | docs.browserbase.com | `sessions.create()`, CDP connect |
| AgentMail | docs.agentmail.to | `inboxes.create()`, `inboxes.messages.list()` |
| Supabase | supabase.com/docs | Auth, RLS, Realtime, Storage |
| PostHog API | posthog.com/docs/api | Session recordings, event queries |
| GitHub Apps | docs.github.com/apps | JWT auth, installation tokens, webhooks |
| Slack Block Kit | api.slack.com/block-kit | Rich message formatting |
| Claude API | docs.anthropic.com | Messages API with tool use |

---

## Cost Model (Per Test Run)

| Component | Estimate |
|---|---|
| Browserbase (3 flows, ~5 min each) | ~$0.03 |
| Claude API (planner + agent reasoning) | ~$0.10–0.30 |
| AgentMail (inbox + message reads) | ~$0.001 |
| GitHub Actions (15 min Ubuntu runner) | ~$0.008 |
| **Total per run** | **~$0.15–0.35** |
| Daily (5 deploys/day) | ~$0.75–1.75 |
| Monthly (150 runs) | ~$22–52 |

---

## Questions for You

Before we start building, a few things I'd like your input on:

1. **Supabase project** — Do you already have a Supabase project created, or should we build everything with local migrations and wire up Supabase later? (I'll proceed with local migrations + types either way.)

2. **GitHub App** — Do you have a GitHub App registered already, or should we document the setup steps for that? (Registration requires manual steps in the GitHub UI.)

3. **Landing page priority** — Should we invest in a polished marketing-style landing page in Phase 1, or is a minimal "login/signup" page sufficient to start? (I'll default to minimal + clean.)

4. **Stagehand model preference** — The `agent()` method supports multiple LLM backends (Claude, GPT-4o, Gemini). Should we standardize on Claude for everything (planner + executor), or would you prefer a different model for agent execution? (I'll default to Claude across the board for consistency.)

5. **Deployment target** — Are you planning to deploy to Vercel from the start, or develop locally first and deploy later? (I'll set up for both, with `vercel.json` cron config included.)

These are non-blocking — I have sensible defaults for all of them. If you want to just say "go build it," I will proceed with the defaults noted above and we can adjust as we go.
