import { z } from 'zod'
import { generateText, Output } from '@/lib/langsmith-ai'
import { model } from '@/lib/ai'

const templateStepSchema = z.object({
  order: z.number(),
  instruction: z.string(),
  type: z.enum(['navigate', 'action', 'assertion', 'extract', 'wait']),
  url: z.string().optional(),
  expected: z.string().optional(),
  timeout: z.number().optional(),
})

const generatedTemplateSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(templateStepSchema),
})

const templatesArraySchema = z.object({
  templates: z.array(generatedTemplateSchema),
})

export type GeneratedTemplate = z.infer<typeof generatedTemplateSchema>

export { generatedTemplateSchema, templateStepSchema }

export async function generateTemplates(context: {
  appUrl: string
  commits: Array<{ sha: string; message: string; date: string; author: string }>
  sessionRecordings: unknown[]
  errorEvents: unknown[]
  topPages: unknown[]
  existingTemplates: Array<{ name: string; description: string | null }>
}): Promise<GeneratedTemplate[]> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: templatesArraySchema }),
    prompt: `You are a QA test planner for ${context.appUrl}. Produce reusable test TEMPLATES that an AI browser agent can execute. Each template maps to one user flow.

# Selection

- Return 3–5 templates. Fewer is better than padding with weak ones.
- Required: at least one smoke test covering auth + a primary navigation path.
- Prioritise, in order: regressions on recently changed code, error-prone flows (exceptions, high drop-off), highest-traffic user journeys.
- Do NOT duplicate any existing template (match on intent, not just name). If an existing one already covers the journey, skip it.

# Template fields

- \`name\`: 4–8 words, descriptive ("Magic link signup + onboarding").
- \`description\`: one sentence, user-centric, stating what the template validates and why it matters.
- \`steps\`: ordered from 1, each doing ONE thing.

# Step-writing rules

- Start with \`navigate\` to an absolute URL based at ${context.appUrl}.
- \`action\` steps name the target ("click the 'Continue' button") and what to type when applicable.
- \`assertion\` steps state the concrete observable ("the 'Welcome back' heading is visible").
- \`wait\` only for real async boundaries (job completion, network flush); never padding.
- \`extract\` only when a later step truly needs captured data.
- Include \`url\` on navigate steps, \`expected\` on assertions, \`timeout\` only when needed above the default.
- Be self-contained — a fresh browser should be able to execute the template end-to-end.

# Context

## Recent git commits
${JSON.stringify(context.commits.slice(0, 20), null, 2)}

## PostHog session recordings
${JSON.stringify(context.sessionRecordings.slice(0, 20), null, 2)}

## Error events
${JSON.stringify(context.errorEvents.slice(0, 20), null, 2)}

## Most visited pages
${JSON.stringify(context.topPages.slice(0, 15), null, 2)}

## Existing templates (do not duplicate)
${JSON.stringify(context.existingTemplates, null, 2)}`,
  })

  return output.templates
}
