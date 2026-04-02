import { z } from 'zod'

export const researchFindingSchema = z.object({
  source: z.string().describe(
    'Integration or source id: github, github_code, posthog, sentry, langsmith, braintrust',
  ),
  category: z.string().describe('Category: recent_changes, errors, user_behavior, performance, llm_failures, test_gaps, codebase_structure'),
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

export const codebaseExplorationResultSchema = z.object({
  summary: z.string().describe('What the codebase is and how it is organized (2-6 sentences)'),
  architecture: z.string().describe('Major packages, apps, modules, and entrypoints'),
  inferredUserFlows: z
    .array(z.string())
    .describe('User-visible flows inferred from routes, pages, or product features'),
  testingImplications: z.string().describe('Auth, forms, payments, edge cases, and risk areas for UI testing'),
  keyPathsExamined: z.array(z.string()).describe('Repository paths that were read or heavily relied on'),
  confidence: z.enum(['high', 'medium', 'low']),
  truncationWarnings: z.array(z.string()).describe('Caps, API limits, or incomplete exploration notes'),
  toolStepsUsed: z.number().describe('Approximate number of tool invocations during exploration'),
})

export type CodebaseExplorationResult = z.infer<typeof codebaseExplorationResultSchema>

/** Output of the integration sandbox research loop (no repo exploration). */
export const integrationResearchReportSchema = z.object({
  summary: z.string().describe('Executive summary of all findings across integrations (2-4 sentences)'),
  findings: z.array(researchFindingSchema).describe('Individual findings from each integration'),
  recommendedFlows: z.array(z.string()).describe('High-level descriptions of UI flows that should be tested based on findings'),
  integrationsCovered: z.array(z.string()).describe('Which integrations were successfully queried'),
  integrationsSkipped: z.array(z.string()).describe('Which integrations failed or had no data'),
})

export type IntegrationResearchReport = z.infer<typeof integrationResearchReportSchema>

export const researchReportSchema = integrationResearchReportSchema.extend({
  summary: z.string().describe('Executive summary of all findings across integrations and codebase (2-6 sentences)'),
  codebaseExploration: codebaseExplorationResultSchema.describe(
    'Structured understanding of the linked GitHub repository from tool-based exploration',
  ),
})

export type ResearchFinding = z.infer<typeof researchFindingSchema>
export type ResearchReport = z.infer<typeof researchReportSchema>

export function emptyCodebaseExploration(overrides?: Partial<CodebaseExplorationResult>): CodebaseExplorationResult {
  return {
    summary: 'No repository analysis was performed.',
    architecture: '',
    inferredUserFlows: [],
    testingImplications: '',
    keyPathsExamined: [],
    confidence: 'low',
    truncationWarnings: [],
    toolStepsUsed: 0,
    ...overrides,
  }
}

const defaultCodebaseExploration = emptyCodebaseExploration()

/** Normalize persisted JSON from DB (older rows may omit codebaseExploration). */
export function normalizeResearchReport(raw: unknown): ResearchReport {
  const parsed = researchReportSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const partial = raw as Record<string, unknown> | null
  if (!partial || typeof partial !== 'object') {
    return {
      summary: 'Research report unavailable.',
      findings: [],
      recommendedFlows: [],
      integrationsCovered: [],
      integrationsSkipped: [],
      codebaseExploration: { ...defaultCodebaseExploration, summary: 'Research report unavailable.' },
    }
  }
  const base = researchReportSchema.safeParse({
    ...partial,
    codebaseExploration: partial.codebaseExploration ?? defaultCodebaseExploration,
  })
  if (base.success) return base.data
  return {
    summary: typeof partial.summary === 'string' ? partial.summary : 'Research report partially available.',
    findings: Array.isArray(partial.findings) ? (partial.findings as ResearchFinding[]) : [],
    recommendedFlows: Array.isArray(partial.recommendedFlows) ? (partial.recommendedFlows as string[]) : [],
    integrationsCovered: Array.isArray(partial.integrationsCovered) ? (partial.integrationsCovered as string[]) : [],
    integrationsSkipped: Array.isArray(partial.integrationsSkipped) ? (partial.integrationsSkipped as string[]) : [],
    codebaseExploration: defaultCodebaseExploration,
  }
}

export interface IntegrationCredentials {
  type: string
  credentials: Record<string, string>
}
