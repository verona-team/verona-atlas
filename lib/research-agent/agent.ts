import { tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { model } from '@/lib/ai'
import { generateText, Output, getLangSmithTracingClient } from '@/lib/langsmith-ai'
import { traceable } from 'langsmith/traceable'
import { Sandbox } from '@vercel/sandbox'
import { executeInSandbox } from './sandbox'
import { integrationResearchReportSchema, type IntegrationResearchReport } from './types'

interface AgentContext {
  appUrl: string
  integrationDocs: Record<string, string>
  integrationEnvVars: Record<string, string>
  sandbox: Sandbox
}

const lsClient = getLangSmithTracingClient()

function buildResearchNotesFromGeneration(result: {
  text: string
  steps: Array<{
    text?: string
    toolResults: Array<{ toolName: string; output: unknown }>
  }>
}): string {
  const chunks: string[] = []
  for (const step of result.steps) {
    if (step.text?.trim()) chunks.push(step.text.trim())
    for (const tr of step.toolResults) {
      if (tr.toolName !== 'execute_code') continue
      const out = tr.output as {
        purpose?: string
        exitCode?: number
        stdout?: string
        stderr?: string
      }
      if (!out || typeof out !== 'object') continue
      chunks.push(
        `[execute_code: ${out.purpose ?? 'unnamed'}] exit ${out.exitCode ?? '?'}\nstdout:\n${out.stdout ?? ''}\nstderr:\n${out.stderr ?? ''}`,
      )
    }
  }
  const joined = chunks.join('\n\n---\n\n')
  return joined || result.text || ''
}

async function runResearchLoopCore(ctx: AgentContext): Promise<IntegrationResearchReport> {
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

  const researchGen = await generateText({
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
        execute: traceable(
          async ({ code, purpose }: { code: string; purpose: string }) => {
            try {
              const result = await executeInSandbox(ctx.sandbox, code, ctx.integrationEnvVars)
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
          {
            name: 'research_execute_code_sandbox',
            run_type: 'tool',
            ...(lsClient ? { client: lsClient } : {}),
            processInputs: (inputs) => ({
              purpose: inputs.purpose,
              codeLength: inputs.code?.length ?? 0,
              codePreview: (inputs.code ?? '').slice(0, 4000),
            }),
            processOutputs: (out) => ({
              purpose: out.purpose,
              exitCode: out.exitCode,
              stdoutPreview: out.stdout?.slice(0, 8000),
              stderrPreview: out.stderr?.slice(0, 2000),
            }),
          },
        ) as (input: { code: string; purpose: string }) => Promise<{
          purpose: string
          exitCode: number
          stdout: string
          stderr?: string
        }>,
      }),
    },
    stopWhen: stepCountIs(15),
  })

  const researchNotes = buildResearchNotesFromGeneration(researchGen)

  const { output: report } = await generateText({
    model,
    output: Output.object({ schema: integrationResearchReportSchema }),
    prompt: `Based on the following research investigation of the web application at ${ctx.appUrl}, produce a structured QA research report.

The research agent investigated these integrations: ${integrationList.join(', ')}

Research notes and findings:
${researchNotes}

Produce a comprehensive report with:
1. An executive summary of all findings
2. Individual findings categorized by source and severity (optional field \`rawData\`: a JSON string of compact supporting facts, e.g. commit SHAs or counts — omit if none)
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

export const runResearchLoop = traceable(runResearchLoopCore, {
  name: 'verona_research_loop',
  ...(lsClient ? { client: lsClient } : {}),
  processInputs: (inputs: AgentContext) => ({
    appUrl: inputs.appUrl,
    integrationTypes: Object.keys(inputs.integrationDocs),
    envVarKeys: Object.keys(inputs.integrationEnvVars),
  }),
  processOutputs: (out) => ({
    summaryPreview: out.summary?.slice(0, 500),
    findingsCount: out.findings?.length ?? 0,
    recommendedFlowCount: out.recommendedFlows?.length ?? 0,
    integrationsCovered: out.integrationsCovered,
    integrationsSkipped: out.integrationsSkipped,
  }),
})
