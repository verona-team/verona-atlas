import { z } from 'zod'
import { generateText, Output } from '@/lib/langsmith-ai'
import { model } from '@/lib/ai'
import { templateStepSchema } from '@/lib/test-planner'
import type { ResearchReport } from '@/lib/research-agent/types'
import type { Json } from '@/lib/supabase/types'

export const proposedFlowSchema = z.object({
  id: z.string().describe('Unique identifier for this flow proposal'),
  name: z.string().describe('Short descriptive name for the test flow'),
  description: z.string().describe('What this test flow validates'),
  rationale: z.string().describe('Why this flow is recommended — reference specific findings from the research report'),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  steps: z.array(templateStepSchema),
})

const flowProposalsSchema = z.object({
  analysis: z.string().describe('Brief analysis of the project state that informed these recommendations'),
  flows: z.array(proposedFlowSchema),
})

export type ProposedFlow = z.infer<typeof proposedFlowSchema>
export type FlowProposals = z.infer<typeof flowProposalsSchema>

export async function generateFlowProposals(
  appUrl: string,
  report: ResearchReport,
): Promise<FlowProposals> {
  const findingsBlock = report.findings.length > 0
    ? report.findings.map((f) =>
        `[${f.source}] (${f.severity}) ${f.category}: ${f.details}`
      ).join('\n')
    : 'No specific findings from integrations.'

  const { output } = await generateText({
    model,
    output: Output.object({ schema: flowProposalsSchema }),
    prompt: `You are a QA strategist for the web application at ${appUrl}.

A research agent has investigated the user's connected integrations and produced the following report:

## Executive Summary
${report.summary}

## Findings
${findingsBlock}

## Recommended Flows (from research)
${report.recommendedFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Coverage
Integrations investigated: ${report.integrationsCovered.join(', ') || 'none'}
Integrations skipped: ${report.integrationsSkipped.join(', ') || 'none'}

Based on this research, generate 3-5 concrete UI test flows. Each flow should:
- Have a unique kebab-case id
- Explain WHY it's recommended by referencing specific findings (commit SHAs, error messages, page URLs, etc.)
- Include detailed step-by-step instructions an AI browser agent can execute
- Be prioritized by severity of the underlying finding

Step types: navigate (go to URL), action (click/type/interact), assertion (verify something), extract (get data), wait (pause)`,
  })

  return output
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
