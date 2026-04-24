# Atlas — Autonomous QA Testing Platform

Atlas is a multi-tenant SaaS platform that provides autonomous browser-based QA testing for engineering teams. Connect your production/staging URL, GitHub repo, PostHog project, and Slack workspace — Atlas will autonomously test your application and report results.

## How It Works

1. **Connect** your app URL, GitHub repo, PostHog project, and Slack workspace
2. **Create test templates** (manually or AI-generated from PostHog + GitHub data)
3. **Run tests** — Atlas spins up isolated cloud browsers, authenticates into your app, and executes AI-driven test flows
4. **Get results** — Detailed reports with screenshots, AI analysis, and bug recommendations delivered to Slack and the dashboard

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| UI | shadcn/ui v4 + Tailwind CSS |
| Database & Auth | Supabase (Postgres, Auth, RLS, Realtime, Storage) |
| Browser Infra | Browserbase (cloud browser sessions) |
| Browser Automation | Stagehand v3 (AI-native browser control) |
| Email (2FA) | AgentMail (programmatic inboxes) |
| LLM | Google Gemini (chat orchestration, research, flow generation, outer QA loop) + Claude (Stagehand browser agent) |
| Compute | Modal.com (Python serverless functions) |
| Integrations | GitHub App, PostHog API, Slack OAuth |

## Architecture

```
Next.js 16 (Vercel)          Modal.com (Python)
┌────────────────────┐       ┌─────────────────────────┐
│ Dashboard (shadcn)  │       │ Test Runner              │
│ Auth (Supabase)     │       │ ├─ Test Planner (Claude) │
│ API Routes          │──────→│ ├─ Stagehand + Browser   │
│ proxy.ts            │ spawn │ ├─ Auth + 2FA (AgentMail)│
└────────┬───────────┘       │ ├─ Results → Supabase    │
         │                    │ └─ Report → Slack        │
         │                    └─────────────────────────┘
    Supabase (Postgres, Auth, Storage, Realtime)
```

## Getting Started

### Prerequisites

- Node.js 22+
- Python 3.13+ (for Modal runner)
- A Supabase project
- API keys for: Modal, Browserbase, AgentMail, Google Gemini, Anthropic (Claude — only used by the Stagehand browser agent)
- GitHub App (for repo integration)
- Slack App (for reporting)

### Setup

1. **Clone and install:**
   ```bash
   git clone <repo-url>
   cd atlas
   pnpm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   # Fill in all API keys and credentials
   ```

3. **Run database migrations:**
   Apply all SQL files in `supabase/migrations/` to your Supabase project via the Supabase dashboard SQL editor or CLI.

4. **Deploy Modal runner:**
   Run from the **repository root** so `add_local_python_source("runner")` resolves to the `runner/` package (deploying from inside `runner/` fails with `runner has no spec`).
   ```bash
   pip install modal
   modal deploy runner/modal_app.py
   ```
   Configure Modal secrets named `atlas-secrets` with the required environment variables.

5. **Start development:**
   ```bash
   pnpm dev
   ```

## Project Structure

```
├── app/                          # Next.js App Router pages
│   ├── (dashboard)/              # Authenticated dashboard
│   │   ├── projects/             # Project management
│   │   │   ├── [projectId]/
│   │   │   │   ├── templates/    # Test template CRUD + AI generation
│   │   │   │   ├── runs/         # Run history + detail with realtime
│   │   │   │   └── settings/     # Integrations management
│   │   └── settings/             # Organization settings
│   ├── (public)/                 # Public pages (landing, auth)
│   ├── actions/                  # Server actions
│   └── api/                      # API routes
│       ├── projects/             # Project CRUD
│       ├── templates/            # Template CRUD + AI generation
│       ├── runs/                 # Run management + trigger
│       └── integrations/         # GitHub, PostHog, Slack OAuth
├── components/                   # React components
│   ├── ui/                       # shadcn/ui components
│   └── dashboard/                # App-specific components
├── hooks/                        # React hooks (realtime, etc.)
├── lib/                          # Server-side utilities
│   ├── supabase/                 # Supabase client helpers + types
│   ├── encryption.ts             # AES-256-GCM
│   ├── github.ts                 # GitHub App integration
│   ├── posthog.ts                # PostHog API client
│   ├── slack.ts                  # Slack OAuth + messaging
│   ├── modal.ts                  # Modal trigger client
│   ├── agentmail.ts              # AgentMail inbox + 2FA
│   └── test-planner.ts           # Claude AI template generation
├── runner/                       # Python — deployed to Modal
│   ├── modal_app.py              # Modal app definition
│   ├── execute.py                # Main orchestrator
│   ├── auth.py                   # Login + 2FA handling
│   ├── test_executor.py          # Template step execution
│   ├── reporter.py               # Slack reporting
│   ├── integrations.py           # GitHub + PostHog Python clients
│   └── encryption.py             # AES-256-GCM decrypt (matches TS)
├── supabase/migrations/          # Database schema SQL files
├── proxy.ts                      # Next.js 16 auth middleware
└── .env.example                  # Environment variable template
```

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin key |
| `ENCRYPTION_KEY` | 64-char hex for AES-256-GCM |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Modal compute credentials |
| `AGENTMAIL_API_KEY` | AgentMail for 2FA handling |
| `GOOGLE_API_KEY` | Google Gemini API (chat orchestrator, research agents, flow generator, outer QA loop, post-run summaries) |
| `ANTHROPIC_API_KEY` | Claude Opus 4.7 API — only used by the Stagehand inner browser agent |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App for repo access |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack for reporting |
| `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` | Cloud browsers |
| `NEXT_PUBLIC_APP_URL` | Canonical app URL (signup email links → `/auth/confirm`) |

### Supabase email confirmation & redirects

1. **Redirect URLs** — In the Supabase dashboard (Authentication → URL configuration), add your confirmation callback, e.g. `https://www.deployverona.com/auth/confirm`, to **Redirect URLs**. The app exchanges the `code` from the query string for a session and then sends users to **`/projects`**.
2. **Site URL** — Can stay as your marketing root (`https://www.deployverona.com/`). Signup uses `emailRedirectTo` pointing at `/auth/confirm`, so confirmed users are no longer dropped on the homepage without a session.
3. **Branded links in email (optional)** — Supabase’s default template still uses `{{ .ConfirmationURL }}`, which points at `*.supabase.co` with a `redirect_to` query param. To show only `deployverona.com` in the message body, customize the template under **Authentication → Email Templates → Confirm signup** and build the link yourself, e.g. `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` (and keep the same path whitelisted as above). The handler at `app/auth/confirm/route.ts` supports both PKCE (`code`) and `token_hash` + `type` flows.

## License

Private — All rights reserved.
