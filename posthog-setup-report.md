<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Verona. Here is a summary of all changes made:

**SDK setup:**
- `instrumentation-client.ts` — updated to use the `/ingest` reverse proxy, `capture_exceptions: true`, and the `defaults: "2026-01-30"` bundle (autocapture, session replay, web vitals, history-change pageviews).
- `next.config.ts` — added PostHog reverse-proxy rewrites (`/ingest/*` → PostHog ingestion host, `/ingest/static/*` and `/ingest/array/*` → assets host) and `skipTrailingSlashRedirect: true`.
- `lib/posthog-server.ts` — new server-side singleton using `posthog-node` for API route event capture.
- `.env.local` — `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` written via wizard-tools.

**Event tracking:**

| Event | Description | File |
|---|---|---|
| `user_signed_up` | User submitted the signup form successfully (email confirmation triggered). Calls `posthog.identify()` with email. | `app/(public)/signup/page.tsx` |
| `user_signed_in` | User signed in via the login form. Calls `posthog.identify()` with email. | `app/(public)/login/page.tsx` |
| `project_created` | New project created via the API (includes agentmail provisioning status). | `app/api/projects/route.ts` |
| `chat_message_sent` | Chat message successfully dispatched to Modal AI worker. | `app/api/chat/route.ts` |
| `github_connected` | GitHub App installation linked to a project (includes reconnect flag). | `app/api/integrations/github/callback/route.ts` |
| `slack_connected` | Slack workspace linked to a project (includes team name and reconnect flag). | `app/api/integrations/slack/callback/route.ts` |
| `project_bootstrapped` | Project bootstrap dispatched for the first time (triggers initial AI setup turn). | `app/api/projects/[projectId]/dispatch-bootstrap/route.ts` |
| `template_created` | User manually created a new test template (includes step count). | `app/(dashboard)/projects/[projectId]/templates/page.tsx` |
| `template_updated` | User updated an existing test template. | `app/(dashboard)/projects/[projectId]/templates/page.tsx` |
| `template_deleted` | User deleted a test template. | `app/(dashboard)/projects/[projectId]/templates/page.tsx` |

## Next steps

We've built a dashboard and five insights to keep an eye on user behavior:

**Dashboard:** https://us.posthog.com/project/398853/dashboard/1518101

**Insights:**
- [User acquisition funnel](https://us.posthog.com/project/398853/insights/Hz1GM2MK) — Signup → project created → bootstrapped → first chat message
- [New signups over time](https://us.posthog.com/project/398853/insights/4qC26E7i) — Daily signup volume
- [Chat engagement — messages sent per day](https://us.posthog.com/project/398853/insights/l4jDbCHS) — Daily message volume and unique active users
- [Integration connections](https://us.posthog.com/project/398853/insights/0rgiVuDt) — GitHub and Slack connection events over time
- [Template activity](https://us.posthog.com/project/398853/insights/BdXo59J8) — Weekly template create/update/delete volume

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
