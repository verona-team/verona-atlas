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
| LLM | Claude API (test planning + analysis) |
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
- API keys for: Modal, Browserbase, AgentMail, Anthropic (Claude)
- GitHub App (for repo integration)
- Slack App (for reporting)

### Setup

1. **Clone and install:**
   ```bash
   git clone <repo-url>
   cd atlas
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env.local
   # Fill in all API keys and credentials
   ```

3. **Run database migrations:**
   Apply all SQL files in `supabase/migrations/` to your Supabase project via the Supabase dashboard SQL editor or CLI.

4. **Deploy Modal runner:**
   ```bash
   cd runner
   pip install modal
   modal deploy modal_app.py
   ```
   Configure Modal secrets named `atlas-secrets` with the required environment variables.

5. **Start development:**
   ```bash
   npm run dev
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
│   ├── planner.py                # AI test prioritization
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
| `ANTHROPIC_API_KEY` | Claude API for AI features |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App for repo access |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack for reporting |
| `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` | Cloud browsers |

## License

Private — All rights reserved.
