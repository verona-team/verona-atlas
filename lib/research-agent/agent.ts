import { generateText, generateObject, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { model } from '@/lib/ai'
import { Sandbox } from '@vercel/sandbox'
import { executeInSandbox } from './sandbox'
import { researchReportSchema, type ResearchReport } from './types'

interface AgentContext {
  appUrl: string
  integrationDocs: Record<string, string>
  integrationEnvVars: Record<string, string>
  sandbox: Sandbox
}

export async function runResearchLoop(ctx: AgentContext): Promise<ResearchReport> {
  const integrationList = Object.keys(ctx.integrationDocs)

  const envVarDocs = Object.entries(ctx.integrationEnvVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const apiDocs = Object.entries(ctx.integrationDocs)
    .map(([type, docs]) => `## ${type.toUpperCase()} API Documentation\n\n${docs}`)
    .join('\n\n---\n\n')

  const systemPrompt = `You are a QA research agent for the web application at ${ctx.appUrl}. Your job is to investigate the user's connected integrations and gather information that will help determine which UI flows are most important to test.

You have access to the following integrations: ${integrationList.join(', ')}

IMPORTANT: Authentication headers are automatically injected for all API requests to the allowed hosts. You do NOT need to set Authorization headers yourself. Just make fetch requests to the API endpoints and auth will be handled.

Available environment variables (use these for API-specific configuration like project IDs):
${envVarDocs}

Write JavaScript code (ES modules, Node 24 with built-in fetch) to query these APIs. Use console.log() to output results as JSON. Each code execution should be focused on one integration or one specific query.

Investigate thoroughly:
- For GitHub: recent commits (last 7 days), open PRs with large diffs, recently merged PRs
- For PostHog: error events, top pages by traffic, session recording counts, user behavior patterns
- For Sentry: unresolved issues sorted by frequency, recent error spikes, most affected URLs
- For LangSmith: failed LLM runs, high-latency traces, error patterns
- For Braintrust: recent experiment results, failing evaluations, score regressions

After gathering data from all available integrations, you will be asked to produce a structured report.`

  const { text: researchNotes } = await generateText({
    model,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Investigate all connected integrations (${integrationList.join(', ')}) and gather data useful for QA test planning. Use the execute_code tool to run JavaScript against the APIs.\n\n${apiDocs}`,
    }],
    tools: {
      execute_code: tool({
        description: 'Execute JavaScript code in a sandboxed Node.js 24 environment with network access to the integration APIs. Auth headers are injected automatically. Use fetch() to call APIs and console.log() to output results.',
        inputSchema: z.object({
          code: z.string().describe('JavaScript (ES module) code to execute. Use fetch() and console.log().'),
          purpose: z.string().describe('Brief description of what this code investigates'),
        }),
        execute: async ({ code, purpose }) => {
          try {
            const result = await executeInSandbox(ctx.sandbox, code)
            return {
              purpose,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr || undefined,
            }
          } catch (e) {
            return {
              purpose,
              exitCode: 1,
              stdout: '',
              stderr: `Execution error: ${String(e)}`,
            }
          }
        },
      }),
    },
    stopWhen: stepCountIs(15),
  })

  const { object: report } = await generateObject({
    model,
    schema: researchReportSchema,
    prompt: `Based on the following research investigation of the web application at ${ctx.appUrl}, produce a structured QA research report.

The research agent investigated these integrations: ${integrationList.join(', ')}

Research notes and findings:
${researchNotes}

Produce a comprehensive report with:
1. An executive summary of all findings
2. Individual findings categorized by source and severity
3. Specific UI flow recommendations based on the data
4. Which integrations were covered vs skipped

Focus the recommended flows on:
- Areas with recent code changes (from GitHub)
- Error-prone pages and flows (from PostHog/Sentry)
- High-traffic user journeys that need regression testing
- AI/LLM features with failures (from LangSmith/Braintrust)`,
  })

  return report
}
