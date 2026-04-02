import { generateObject } from 'ai'
import { z } from 'zod'
import { chatModel } from '@/lib/ai'
import { templateStepSchema } from '@/lib/test-planner'
import type { Json } from '@/lib/supabase/types'

export const proposedFlowSchema = z.object({
  id: z.string().describe('Unique identifier for this flow proposal'),
  name: z.string().describe('Short descriptive name for the test flow'),
  description: z.string().describe('What this test flow validates'),
  rationale: z.string().describe('Why this flow is recommended based on the data'),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  steps: z.array(templateStepSchema),
})

const flowProposalsSchema = z.object({
  analysis: z.string().describe('Brief analysis of the project state that informed these recommendations'),
  flows: z.array(proposedFlowSchema),
})

export type ProposedFlow = z.infer<typeof proposedFlowSchema>
export type FlowProposals = z.infer<typeof flowProposalsSchema>

interface IntegrationContext {
  commits: Array<{ sha: string; message: string; date: string; author: string }>
  sessionRecordings: unknown[]
  errorEvents: unknown[]
  topPages: unknown[]
  sentryIssues: unknown[]
  existingTemplates: Array<{ name: string; description: string | null }>
}

export async function generateFlowProposals(
  appUrl: string,
  context: IntegrationContext,
): Promise<FlowProposals> {
  const sections: string[] = []

  if (context.commits.length > 0) {
    sections.push(`## Recent Git Commits\n${JSON.stringify(context.commits.slice(0, 20), null, 2)}`)
  }
  if (context.sessionRecordings.length > 0) {
    sections.push(`## PostHog Session Recordings\n${JSON.stringify(context.sessionRecordings.slice(0, 15), null, 2)}`)
  }
  if (context.errorEvents.length > 0) {
    sections.push(`## PostHog Error Events\n${JSON.stringify(context.errorEvents.slice(0, 15), null, 2)}`)
  }
  if (context.topPages.length > 0) {
    sections.push(`## Most Visited Pages\n${JSON.stringify(context.topPages.slice(0, 15), null, 2)}`)
  }
  if (context.sentryIssues.length > 0) {
    sections.push(`## Sentry Issues (unresolved)\n${JSON.stringify(context.sentryIssues.slice(0, 10), null, 2)}`)
  }
  if (context.existingTemplates.length > 0) {
    sections.push(`## Existing Test Templates (avoid duplicates)\n${JSON.stringify(context.existingTemplates, null, 2)}`)
  }

  const contextBlock = sections.length > 0
    ? sections.join('\n\n')
    : 'No integration data available yet. Generate general smoke tests and common user flow tests based on the app URL.'

  const { object } = await generateObject({
    model: chatModel,
    schema: flowProposalsSchema,
    prompt: `You are a QA strategist for the web application at ${appUrl}.

Analyze the following data and propose 3-5 UI test flows that would be most valuable to run. Each flow should test a specific user journey end-to-end.

${contextBlock}

Prioritize:
1. Flows directly affected by recent code changes (if commits are available)
2. High-traffic user flows (from session/page data)
3. Error-prone flows (from error events and Sentry issues)
4. Critical business flows (auth, checkout, data creation)
5. At least one basic smoke test

For each flow:
- Give it a unique id (use kebab-case like "login-dashboard-flow")
- Explain WHY you're recommending it in the rationale (reference specific commits, errors, or data)
- Write clear step-by-step instructions an AI browser agent can execute
- Set appropriate priority level

Step types: navigate (go to URL), action (click/type/interact), assertion (verify something), extract (get data), wait (pause)`,
  })

  return object
}

export function serializeFlowsForMessage(proposals: FlowProposals): {
  content: string
  metadata: Record<string, Json>
} {
  const flowList = proposals.flows
    .map((f, i) => `**${i + 1}. ${f.name}** (${f.priority} priority)\n${f.description}\n_Rationale: ${f.rationale}_\n${f.steps.length} steps`)
    .join('\n\n')

  const content = `${proposals.analysis}\n\nHere are the UI flows I recommend testing:\n\n${flowList}\n\nYou can approve, reject, or edit each flow. Once you're happy with the test plan, just tell me to start testing and I'll kick off the browser sessions.`

  const metadata = {
    type: 'flow_proposals' as Json,
    proposals: proposals as unknown as Json,
    flow_states: Object.fromEntries(
      proposals.flows.map((f) => [f.id, 'pending'])
    ) as Json,
  }

  return { content, metadata }
}
