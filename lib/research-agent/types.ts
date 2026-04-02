import { z } from 'zod'

export const researchFindingSchema = z.object({
  source: z.string().describe('Integration name: github, posthog, sentry, langsmith, or braintrust'),
  category: z.string().describe('Category: recent_changes, errors, user_behavior, performance, llm_failures, test_gaps'),
  details: z.string().describe('Natural language description of what was found'),
  severity: z.enum(['critical', 'high', 'medium', 'low']).describe('How important this finding is for QA'),
  // Must be a concrete JSON-Schema type for Anthropic structured outputs
  // (`z.unknown()` becomes `{ description: ... }` with no `type` and triggers 400).
  rawData: z
    .string()
    .optional()
    .describe(
      'Optional JSON string of supporting data (e.g. commit SHAs, counts, URLs) — not natural language; use `details` for prose',
    ),
})

export const researchReportSchema = z.object({
  summary: z.string().describe('Executive summary of all findings across integrations (2-4 sentences)'),
  findings: z.array(researchFindingSchema).describe('Individual findings from each integration'),
  recommendedFlows: z.array(z.string()).describe('High-level descriptions of UI flows that should be tested based on findings'),
  integrationsCovered: z.array(z.string()).describe('Which integrations were successfully queried'),
  integrationsSkipped: z.array(z.string()).describe('Which integrations failed or had no data'),
})

export type ResearchFinding = z.infer<typeof researchFindingSchema>
export type ResearchReport = z.infer<typeof researchReportSchema>

export interface IntegrationCredentials {
  type: string
  credentials: Record<string, string>
}
