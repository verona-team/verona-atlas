<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

### Overview

Atlas is an autonomous QA testing platform. The codebase has two components:
- **Next.js 16 web app** (TypeScript) — root of the repo, runs with `pnpm dev`
- **Python runner** — `runner/` directory, deployed to Modal.com (not needed for local dev)

### Quick reference

| Action | Command |
|--------|---------|
| Install deps | `pnpm install` |
| Dev server | `pnpm dev` (port 3000) |
| Lint | `pnpm lint` (ESLint 9) |
| Build | `pnpm build` |

### Environment variables

All secrets are injected as environment variables. The `.env.local` file must be generated from them at setup time (it is gitignored). See `.env.example` for the full list. The minimum required for the web app to start: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL`.

### Gotchas

- The project uses **Next.js 16** with breaking changes vs earlier versions. Always read docs in `node_modules/next/dist/docs/` before making code changes.
- pnpm install shows warnings about ignored build scripts (cbor-extract, msw, protobufjs, sharp, unrs-resolver). These are safe to ignore — do NOT run `pnpm approve-builds` (interactive).
- Supabase is hosted (no local Supabase CLI config). Auth and database depend on the hosted project credentials in env vars.
- The Python runner (`runner/`) requires Python 3.13+ and Modal.com credentials. It is optional for local web development.
