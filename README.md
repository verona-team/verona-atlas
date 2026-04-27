# Verona Atlas

Connect your app, GitHub repo, PostHog project, and Slack workspace. Atlas spins up cloud browsers, runs AI-driven test flows, and reports back.

## Stack

Next.js 16 · Supabase · Modal · Browserbase · Stagehand · Gemini + Claude

## Getting Started

```bash
pnpm install
cp .env.example .env.local   # fill in keys
pnpm dev
```

Apply SQL files in `supabase/migrations/` to your Supabase project, then deploy the runner from the repo root:

```bash
modal deploy runner/modal_app.py
```

See `.env.example` for required environment variables.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
