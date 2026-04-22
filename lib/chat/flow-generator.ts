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
    prompt: `You are a QA strategist producing UI test flow proposals for ${appUrl}. Your output feeds directly into approvable cards in the user's chat UI and an AI browser agent that will execute approved flows.

# Selection rules

- Return AT MOST 3 flows. Prefer fewer (even 1) if only a couple of findings truly dominate risk. Never return 0.
- Every flow must be grounded in a specific finding from the research below — a commit SHA, PR number, URL, route, error message, rage-click page, or code reference. If you can't anchor a flow to evidence, drop it.
- Prioritise by user impact and freshness: critical for things actively breaking for real users; high for risky areas of heavy recent change; medium/low only when higher-priority candidates are already covered.
- Avoid near-duplicates. If two candidates test the same underlying change, merge them or drop the weaker one.
- Always include at least one happy-path smoke flow touching auth + a core journey UNLESS a direct regression flow already exercises that path.

# Flow schema requirements

- \`id\`: short, unique, kebab-case. Descriptive (e.g. \`sheet-autosave-conflict\`), not generic (\`flow-1\`).
- \`name\`: 4–8 words, human-readable.
- \`description\`: one sentence stating what the flow validates, in user terms.
- \`rationale\`: one or two sentences citing the concrete evidence (e.g. "PR #206 replaced the pipeline (33 files changed)" or "290 rage clicks on /w/*/sheets in the last 14 days").
- \`priority\`: critical | high | medium | low.
- \`steps\`: ordered, executable, self-contained instructions for a browser agent that starts from a blank browser. Include credentials/test-account hints only if the research explicitly provides them.

# Step-writing rules

- First step is almost always \`navigate\` to an absolute URL starting from ${appUrl}.
- Each step does ONE thing. Break compound actions apart.
- \`action\` steps name the target element ("click the 'Add column' button in the toolbar") and what to type when relevant.
- \`assertion\` steps state the concrete observable ("the new column 'Full Name' appears as the rightmost header and persists after reload").
- Add a \`wait\` step only when a real async boundary exists (autosave flush, network fetch, job completion) — don't pad.
- Include \`url\` on navigate steps. Include \`expected\` on assertion steps. Set \`timeout\` only when a step legitimately needs longer than default (e.g. long-running enrichment).
- Steps should be numbered sequentially from 1.

# Analysis field

2–3 sentences. State the single biggest risk and why the proposed flows address it. Do not restate flow names or counts.

# Research context

## Executive summary
${report.summary}

## Findings
${findingsBlock}

${codebaseBlock}

## Candidate flow ideas (from research — use as inspiration, do not copy verbatim)
${report.recommendedFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

## Coverage
Investigated: ${report.integrationsCovered.join(', ') || 'none'}
Skipped: ${report.integrationsSkipped.join(', ') || 'none'}

# Output formatting

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
