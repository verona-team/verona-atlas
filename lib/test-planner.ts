import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

interface GeneratedTemplate {
  name: string
  description: string
  steps: Array<{
    order: number
    instruction: string
    type: 'navigate' | 'action' | 'assertion' | 'extract' | 'wait'
    url?: string
    expected?: string
    timeout?: number
  }>
}

export type { GeneratedTemplate }

export async function generateTemplates(context: {
  appUrl: string
  commits: Array<{ sha: string; message: string; date: string; author: string }>
  sessionRecordings: unknown[]
  errorEvents: unknown[]
  topPages: unknown[]
  existingTemplates: Array<{ name: string; description: string | null }>
}): Promise<GeneratedTemplate[]> {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a QA test planner for a web application at ${context.appUrl}.

Given the following context about recent activity:

## Recent Git Commits
${JSON.stringify(context.commits.slice(0, 20), null, 2)}

## PostHog Session Recordings (recent user sessions)
${JSON.stringify(context.sessionRecordings.slice(0, 20), null, 2)}

## Error Events
${JSON.stringify(context.errorEvents.slice(0, 20), null, 2)}

## Most Visited Pages
${JSON.stringify(context.topPages.slice(0, 15), null, 2)}

## Existing Test Templates (avoid duplicates)
${JSON.stringify(context.existingTemplates, null, 2)}

Generate 3-5 test templates that would be most valuable to run. Each template should test a specific user flow.

Prioritize:
- Flows affected by recent code changes
- Most common user flows from session data
- Error-prone flows (exceptions, high drop-off)
- Always include at least one smoke test (basic auth + navigation)

For each step, the "instruction" should be a clear natural language instruction that an AI browser agent can execute.
Step types: navigate (go to URL), action (click/type/interact), assertion (verify something is visible/correct), extract (get data from page), wait (pause)

Return ONLY a valid JSON array of templates. No markdown, no explanation.
Each template: { "name": "...", "description": "...", "steps": [{ "order": 1, "instruction": "...", "type": "...", "url": "..." }] }`,
    }],
  })

  const content = message.content[0]
  if (content.type !== 'text') throw new Error('Unexpected response type')

  let text = content.text.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  return JSON.parse(text) as GeneratedTemplate[]
}
