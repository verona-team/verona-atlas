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
  analysis: z
    .string()
    .describe('Very brief analysis (2–3 sentences max) of what matters most for testing right now'),
  flows: z.array(proposedFlowSchema).max(3),
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

  const ce = report.codebaseExploration
  const codebaseBlock = ce
    ? `## Repository understanding (${ce.confidence} confidence)
${ce.summary}

Architecture: ${ce.architecture || '—'}

Inferred flows from code: ${ce.inferredUserFlows.length ? ce.inferredUserFlows.join('; ') : '—'}

Testing implications: ${ce.testingImplications || '—'}
Key paths: ${ce.keyPathsExamined.slice(0, 30).join(', ') || '—'}`
    : ''

  const { output } = await generateText({
    model,
    output: Output.object({ schema: flowProposalsSchema }),
    prompt: `You are a QA strategist for the web application at ${appUrl}.

A research agent has investigated the user's connected integrations and linked GitHub repository.

## Executive Summary
${report.summary}

## Findings
${findingsBlock}

${codebaseBlock}

## Recommended Flows (from research)
${report.recommendedFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Coverage
Integrations investigated: ${report.integrationsCovered.join(', ') || 'none'}
Integrations skipped: ${report.integrationsSkipped.join(', ') || 'none'}

Based on this research, generate at most 3 concrete UI test flows—only the highest-impact ones; fewer is fine if two flows clearly dominate. Never return more than 3 flows. Each flow should:
- Have a unique kebab-case id
- Explain WHY it's recommended by referencing specific findings (commits, errors, URLs, routes, or code structure from the repository section)
- Include detailed step-by-step instructions an AI browser agent can execute
- Be prioritized by severity of the underlying finding

Step types: navigate (go to URL), action (click/type/interact), assertion (verify something), extract (get data), wait (pause)

Do not include any emoji characters in the analysis, flow names, descriptions, rationales, or steps. Use plain text only.`,
  })

  return output
}

/**
 * LLM outputs can repeat the same kebab-case id for multiple flows. Using those ids
 * as object keys collapses `flow_states` to a single entry so one approval/rejection
 * applies to every card that shares the id. Assign stable unique ids before persisting.
 */
function dedupeFlowIds(flows: FlowProposals['flows']): FlowProposals['flows'] {
  const seen = new Map<string, number>()
  return flows.map((flow) => {
    const n = (seen.get(flow.id) ?? 0) + 1
    seen.set(flow.id, n)
    if (n === 1) return flow
    return { ...flow, id: `${flow.id}-${n}` }
  })
}

export function serializeFlowsForMessage(proposals: FlowProposals): {
  content: string
  metadata: Record<string, Json>
  flows: FlowProposals['flows']
} {
  const flows = dedupeFlowIds(proposals.flows)
  const proposalsForStorage: FlowProposals = { ...proposals, flows }

  const flowList = flows
    .map((f, i) => `**${i + 1}. ${f.name}** (${f.priority} priority)\n${f.description}\n_Rationale: ${f.rationale}_\n${f.steps.length} steps`)
    .join('\n\n')

  const content = `${proposals.analysis}\n\n**Flows to test (max 3):**\n\n${flowList}\n\nApprove, reject, or edit each; say when to start testing.`

  const flow_states: Record<string, Json> = {}
  for (const f of flows) {
    flow_states[f.id] = 'pending'
  }

  const metadata = {
    type: 'flow_proposals' as Json,
    proposals: proposalsForStorage as unknown as Json,
    flow_states: flow_states as Json,
  }

  return { content, metadata, flows }
}
