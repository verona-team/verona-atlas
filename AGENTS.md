<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

### Overview

Atlas is an autonomous QA testing SaaS platform. The main application is a **Next.js 16** app (TypeScript, shadcn/ui v4, Tailwind CSS) backed by **Supabase** (Postgres, Auth, Storage, Realtime). There is also a Python-based test runner in `runner/` deployed to Modal.com, but it is not needed for local frontend development.

### Quick reference

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev server | `pnpm dev` (port 3000) |
| Lint | `pnpm lint` |
| Type check | `npx tsc --noEmit` |
| Build | `pnpm build` |

### Environment

A `.env.local` file is required at the repo root with values for the keys listed in `.env.example`. All secrets are injected as environment variables in the Cloud Agent VM — generate `.env.local` from them. The file is gitignored.

### Caveats

- **pnpm install warnings about ignored build scripts** (`cbor-extract`, `msw`, `protobufjs`, `sharp`, `unrs-resolver`) are expected and do not affect functionality. Do NOT run `pnpm approve-builds` (it's interactive).
- **ESLint has 4 pre-existing errors** (React hooks `set-state-in-effect`, `refs` rules). These are in existing code and not regressions.
- The **proxy** (auth middleware) is at `proxy.ts` in the repo root (Next.js 16 convention), not `middleware.ts`.
- **Supabase** is hosted — the app connects to a remote Supabase project via env vars. No local Supabase CLI/Docker setup is needed.
- The Python `runner/` directory is deployed separately to Modal.com and is not exercised by `pnpm dev`.
