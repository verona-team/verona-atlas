<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of your project. PostHog was already initialized via `instrumentation-client.ts` with a reverse proxy configured in `next.config.ts`. The existing setup included `posthog-js` and `posthog-node`, a server-side client in `lib/posthog-server.ts`, and several events already tracked (`user_signed_in`, `user_signed_up`, `project_created`, `github_connected`, `slack_connected`, `project_bootstrapped`, `chat_message_sent`). The wizard supplemented those with 8 new events across 5 files, covering additional integration connects, project deletion, flow proposal decisions, and the project setup CTA view.

| Event | Description | File |
|-------|-------------|------|
| `posthog_integration_connected` | User successfully connects their PostHog integration to a project | `app/api/integrations/posthog/connect/route.ts` |
| `sentry_integration_connected` | User successfully connects their Sentry integration to a project | `app/api/integrations/sentry/connect/route.ts` |
| `langsmith_integration_connected` | User successfully connects their LangSmith integration to a project | `app/api/integrations/langsmith/connect/route.ts` |
| `braintrust_integration_connected` | User successfully connects their Braintrust integration to a project | `app/api/integrations/braintrust/connect/route.ts` |
| `project_deleted` | User deletes a project | `app/api/projects/[projectId]/route.ts` |
| `flow_proposal_approved` | User approves a proposed test flow from the agent | `components/chat/flow-proposal-card.tsx` |
| `flow_proposal_rejected` | User rejects a proposed test flow from the agent | `components/chat/flow-proposal-card.tsx` |
| `project_setup_cta_viewed` | User views the project setup CTA page (top of bootstrap conversion funnel) | `components/chat/project-setup-cta.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard — Analytics basics**: https://us.posthog.com/project/398853/dashboard/1518157
- **Signup to First Chat Funnel** (5-step activation funnel): https://us.posthog.com/project/398853/insights/45Ni9xqj
- **New Signups Over Time** (daily trend): https://us.posthog.com/project/398853/insights/sYUpBMKz
- **Daily Chat Activity** (engagement metric): https://us.posthog.com/project/398853/insights/WjHoQ1zp
- **Flow Proposal Approval vs Rejection** (agent quality signal): https://us.posthog.com/project/398853/insights/HKXKqdU9
- **Integration Adoption** (which integrations users connect): https://us.posthog.com/project/398853/insights/vVB8Kckq

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
