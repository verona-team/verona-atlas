import { tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { model } from '@/lib/ai'
import { generateText, Output, getLangSmithTracingClient } from '@/lib/langsmith-ai'
import { traceable } from 'langsmith/traceable'
import { Sandbox } from '@vercel/sandbox'
import { executeInSandbox } from './sandbox'
import { integrationResearchReportSchema, type IntegrationResearchReport } from './types'
import type { ProgressCallback, AgentActionIntegration } from '@/lib/chat/agent-actions'

interface AgentContext {
  appUrl: string
  integrationDocs: Record<string, string>
  integrationEnvVars: Record<string, string>
  sandbox: Sandbox
  onProgress?: ProgressCallback
}

function isTransientError(stderr: string): boolean {
  const transientPatterns = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE',
    'socket hang up', 'network timeout', 'fetch failed',
    'Unexpected end of JSON input', '429', 'Too Many Requests',
    '502', '503', '504', 'Bad Gateway', 'Service Unavailable',
  ]
  const lower = stderr.toLowerCase()
  return transientPatterns.some((p) => lower.includes(p.toLowerCase()))
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

const PREFLIGHT_SCRIPTS: Record<string, (envVars: Record<string, string>) => string> = {
  github: (env) => `
const owner = '${(env.GITHUB_REPOS || '').split('/')[0]}';
const repo = '${(env.GITHUB_REPOS || '').split('/')[1] || ''}';
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const results = {};

const [commitsRes, openPrsRes, closedPrsRes] = await Promise.all([
  fetch(\`https://api.github.com/repos/\${owner}/\${repo}/commits?since=\${since}&per_page=100\`),
  fetch(\`https://api.github.com/repos/\${owner}/\${repo}/pulls?state=open&sort=updated&per_page=30\`),
  fetch(\`https://api.github.com/repos/\${owner}/\${repo}/pulls?state=closed&sort=updated&per_page=30\`),
]);

const commits = await commitsRes.json();
results.commits = { total: commits.length, items: commits.map(c => ({ sha: c.sha?.slice(0,8), message: c.commit?.message?.split('\\n')[0]?.slice(0,120), author: c.commit?.author?.name, date: c.commit?.author?.date, login: c.author?.login })) };

const openPrs = await openPrsRes.json();
results.openPrs = openPrs.map(p => ({ number: p.number, title: p.title?.slice(0,100), author: p.user?.login, created_at: p.created_at, additions: p.additions, deletions: p.deletions, changed_files: p.changed_files, draft: p.draft }));

const closedPrs = await closedPrsRes.json();
const merged = closedPrs.filter(p => p.merged_at);
results.mergedPrs = merged.map(p => ({ number: p.number, title: p.title?.slice(0,100), author: p.user?.login, merged_at: p.merged_at, additions: p.additions, deletions: p.deletions, changed_files: p.changed_files, head_branch: p.head?.ref }));

console.log(JSON.stringify(results, null, 2));
`,

  posthog: (env) => `
const host = process.env.POSTHOG_HOST || '${env.POSTHOG_HOST || 'https://us.posthog.com'}';
const projectId = process.env.POSTHOG_PROJECT_ID || '${env.POSTHOG_PROJECT_ID || ''}';
const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const results = {};

async function hogql(query) {
  const res = await fetch(\`\${host}/api/projects/\${projectId}/query/\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  return res.json();
}

const [eventTypes, topPages, exceptions, rageClicks, recordings] = await Promise.all([
  hogql(\`SELECT event, count() as cnt FROM events WHERE timestamp > '\${since}' GROUP BY event ORDER BY cnt DESC LIMIT 20\`),
  hogql(\`SELECT properties.$current_url as url, count() as views, count(distinct distinct_id) as users FROM events WHERE event = '$pageview' AND timestamp > '\${since}' GROUP BY url ORDER BY views DESC LIMIT 40\`),
  hogql(\`SELECT properties.$current_url as url, properties.$exception_type as type, properties.$exception_message as msg, count() as cnt FROM events WHERE event = '$exception' AND timestamp > '\${since}' GROUP BY url, type, msg ORDER BY cnt DESC LIMIT 30\`),
  hogql(\`SELECT properties.$current_url as url, count() as cnt FROM events WHERE event = '$rageclick' AND timestamp > '\${since}' GROUP BY url ORDER BY cnt DESC LIMIT 30\`),
  fetch(\`\${host}/api/projects/\${projectId}/session_recordings/?limit=50\`).then(r => r.json()),
]);

results.eventTypes = eventTypes.results;
results.topPages = topPages.results;
results.exceptions = exceptions.results;
results.rageClicks = rageClicks.results;
results.recordings = { count: recordings.results?.length ?? 0, items: (recordings.results || []).slice(0, 20).map(r => ({ id: r.id, duration: r.recording_duration, clicks: r.click_count, keypresses: r.keypress_count, start_url: r.start_url, active_seconds: r.active_seconds })) };

console.log(JSON.stringify(results, null, 2));
`,

  langsmith: (_env) => `
const results = {};

const sessionsRes = await fetch('https://api.smith.langchain.com/api/v1/sessions?limit=100');
const sessions = await sessionsRes.json();
results.projects = sessions.map(s => ({ id: s.id, name: s.name }));

const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const activeProjects = [];

for (const session of sessions.slice(0, 8)) {
  const runsRes = await fetch('https://api.smith.langchain.com/api/v1/runs/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: [session.id], filter: \`gte(start_time, "\${since}")\`, limit: 30, select: ['name', 'run_type', 'status', 'error', 'start_time', 'end_time', 'total_tokens', 'prompt_tokens', 'completion_tokens'] }),
  });
  const data = await runsRes.json();
  const runs = data.runs || [];
  if (runs.length > 0) {
    const errors = runs.filter(r => r.error || r.status === 'error');
    activeProjects.push({
      project: session.name,
      projectId: session.id,
      totalRuns: runs.length,
      errorCount: errors.length,
      runs: runs.map(r => ({ name: r.name, run_type: r.run_type, status: r.status, error: r.error?.slice(0, 200), start_time: r.start_time, latency_ms: r.end_time && r.start_time ? new Date(r.end_time).getTime() - new Date(r.start_time).getTime() : null, total_tokens: r.total_tokens })),
    });
  }
}

results.activeProjects = activeProjects;
console.log(JSON.stringify(results, null, 2));
`,

  sentry: (env) => `
const orgSlug = process.env.SENTRY_ORG_SLUG || '${env.SENTRY_ORG_SLUG || ''}';
const projectSlug = process.env.SENTRY_PROJECT_SLUG || '${env.SENTRY_PROJECT_SLUG || ''}';
const results = {};

const [issuesRes, eventsRes] = await Promise.all([
  fetch(\`https://sentry.io/api/0/projects/\${orgSlug}/\${projectSlug}/issues/?query=is:unresolved&sort=freq&limit=30\`),
  fetch(\`https://sentry.io/api/0/projects/\${orgSlug}/\${projectSlug}/events/?full=true&limit=30\`),
]);

results.unresolvedIssues = (await issuesRes.json()).map(i => ({ id: i.id, title: i.title, culprit: i.culprit, count: i.count, firstSeen: i.firstSeen, lastSeen: i.lastSeen, level: i.level }));
results.recentEvents = (await eventsRes.json()).map(e => ({ id: e.eventID, title: e.title, message: e.message?.slice(0, 200), level: e.level, dateCreated: e.dateCreated }));

console.log(JSON.stringify(results, null, 2));
`,

  braintrust: (_env) => `
const results = {};
const projectsRes = await fetch('https://api.braintrust.dev/v1/project?limit=100');
const projects = await projectsRes.json();
results.projects = (projects.objects || []).map(p => ({ id: p.id, name: p.name }));

for (const project of results.projects.slice(0, 5)) {
  const expRes = await fetch(\`https://api.braintrust.dev/v1/experiment?project_id=\${project.id}&limit=10\`);
  const experiments = await expRes.json();
  project.experiments = (experiments.objects || []).map(e => ({ id: e.id, name: e.name, created: e.created }));
}

console.log(JSON.stringify(results, null, 2));
`,
}

const INTEGRATION_LABELS: Record<string, string> = {
  github: 'GitHub',
  posthog: 'PostHog',
  sentry: 'Sentry',
  langsmith: 'LangSmith',
  braintrust: 'Braintrust',
}

async function runPreflightScripts(
  ctx: AgentContext,
): Promise<Record<string, { success: boolean; data: string; error?: string }>> {
  const integrationList = Object.keys(ctx.integrationDocs)
  const results: Record<string, { success: boolean; data: string; error?: string }> = {}

  const tasks = integrationList
    .filter((type) => PREFLIGHT_SCRIPTS[type])
    .map(async (type) => {
      const actionId = `preflight-${type}`
      const label = INTEGRATION_LABELS[type] || type
      ctx.onProgress?.({
        actionId,
        integration: type as AgentActionIntegration,
        label: `Pulling data from ${label}`,
        detail: `Running preflight queries against ${label} API`,
        status: 'running',
      })
      try {
        const script = PREFLIGHT_SCRIPTS[type](ctx.integrationEnvVars)
        const result = await executeInSandbox(ctx.sandbox, script, ctx.integrationEnvVars)
        results[type] = {
          success: result.exitCode === 0,
          data: result.stdout,
          error: result.exitCode !== 0 ? result.stderr : undefined,
        }
        ctx.onProgress?.({
          actionId,
          integration: type as AgentActionIntegration,
          label: `Pulled data from ${label}`,
          detail: result.exitCode === 0
            ? `Received ${Math.round(result.stdout.length / 1024)}KB of data`
            : `Preflight failed: ${result.stderr?.slice(0, 120)}`,
          status: result.exitCode === 0 ? 'complete' : 'error',
        })
      } catch (e) {
        results[type] = { success: false, data: '', error: String(e) }
        ctx.onProgress?.({
          actionId,
          integration: type as AgentActionIntegration,
          label: `Failed to pull data from ${label}`,
          detail: String(e).slice(0, 120),
          status: 'error',
        })
      }
    })

  for (const task of tasks) {
    await task
  }

  return results
}

async function runResearchLoopCore(ctx: AgentContext): Promise<IntegrationResearchReport> {
  const integrationList = Object.keys(ctx.integrationDocs)

  ctx.onProgress?.({
    actionId: 'integration-preflight',
    integration: 'system',
    label: 'Starting integration research',
    detail: `Querying ${integrationList.length} integration(s): ${integrationList.map(t => INTEGRATION_LABELS[t] || t).join(', ')}`,
    status: 'running',
  })

  const preflightResults = await runPreflightScripts(ctx)

  ctx.onProgress?.({
    actionId: 'integration-preflight',
    integration: 'system',
    label: 'Preflight data collection complete',
    detail: `Collected data from ${Object.values(preflightResults).filter(r => r.success).length}/${integrationList.length} integrations`,
    status: 'complete',
  })

  const preflightSummary = Object.entries(preflightResults)
    .map(([type, result]) => {
      if (result.success) {
        return `## ${type.toUpperCase()} Preflight Data (auto-collected)\n\n\`\`\`json\n${result.data.slice(0, 12000)}\n\`\`\``
      }
      return `## ${type.toUpperCase()} Preflight Data\n\nFailed: ${result.error?.slice(0, 500) ?? 'unknown error'}. Use execute_code to investigate manually.`
    })
    .join('\n\n---\n\n')

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

IMPORTANT RULES:
- Preflight data has already been collected for each integration (see below). Review it first and focus your tool calls on DEEPER investigation — drill into specific findings, correlate data across sources, and fill gaps.
- Do NOT re-fetch data that the preflight scripts already collected unless you need more detail.
- Run code executions SEQUENTIALLY (one at a time) to avoid stdout collision in the sandbox.

Investigation priorities:
- For GitHub: analyze the preflight commit/PR data, then drill into specific large PRs for file-level changes, look for patterns in bug fix commits, check for open issues
- For PostHog: analyze the preflight rage click and traffic data, then drill into specific session recordings for high-rage-click pages, look for autocapture interaction patterns
- For Sentry: analyze the preflight error data, then drill into top issues for stack traces and affected URLs
- For LangSmith: analyze the preflight run data, then drill into error details, token usage patterns, and latency outliers
- For Braintrust: analyze the preflight experiment data, then check for score regressions

After gathering data from all available integrations, you will be asked to produce a structured report.`

  ctx.onProgress?.({
    actionId: 'deep-investigation',
    integration: 'system',
    label: 'Running deep investigation',
    detail: 'AI agent is analyzing data and querying APIs for deeper insights',
    status: 'running',
  })

  let executeCodeCounter = 0

  const researchGen = await generateText({
    model,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Investigate all connected integrations (${integrationList.join(', ')}) and gather data useful for QA test planning. Use the execute_code tool to run JavaScript against the APIs.

## Preflight Data (already collected)

${preflightSummary}

## API Documentation

${apiDocs}

Review the preflight data above. Then use execute_code for DEEPER investigation — drill into specific findings, correlate across integrations, and fill any gaps. Do NOT re-fetch what the preflight already provides.`,
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
            executeCodeCounter++
            const actionId = `execute-code-${executeCodeCounter}`
            const detectedIntegration = inferIntegrationFromPurpose(purpose, integrationList)
            ctx.onProgress?.({
              actionId,
              integration: detectedIntegration,
              label: purpose,
              detail: `Executing sandbox code (step ${executeCodeCounter})`,
              status: 'running',
            })
            const MAX_RETRIES = 2
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              try {
                const result = await executeInSandbox(ctx.sandbox, code, ctx.integrationEnvVars)
                if (result.exitCode !== 0 && attempt < MAX_RETRIES && isTransientError(result.stderr)) {
                  await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
                  continue
                }
                ctx.onProgress?.({
                  actionId,
                  integration: detectedIntegration,
                  label: purpose,
                  detail: result.exitCode === 0
                    ? `Received ${Math.round(result.stdout.length / 1024)}KB`
                    : `Error: ${result.stderr?.slice(0, 100)}`,
                  status: result.exitCode === 0 ? 'complete' : 'error',
                })
                return {
                  purpose,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr || undefined,
                }
              } catch (e) {
                if (attempt < MAX_RETRIES) {
                  await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
                  continue
                }
                ctx.onProgress?.({
                  actionId,
                  integration: detectedIntegration,
                  label: purpose,
                  detail: `Execution error: ${String(e).slice(0, 100)}`,
                  status: 'error',
                })
                return {
                  purpose,
                  exitCode: 1,
                  stdout: '',
                  stderr: `Execution error: ${String(e)}`,
                }
              }
            }
            return { purpose, exitCode: 1, stdout: '', stderr: 'Max retries exceeded' }
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
    stopWhen: stepCountIs(20),
  })

  const researchNotes = buildResearchNotesFromGeneration(researchGen)

  ctx.onProgress?.({
    actionId: 'deep-investigation',
    integration: 'system',
    label: 'Deep investigation complete',
    detail: `Executed ${executeCodeCounter} sandbox queries`,
    status: 'complete',
  })

  ctx.onProgress?.({
    actionId: 'synthesize-report',
    integration: 'system',
    label: 'Synthesizing research report',
    detail: 'Analyzing all findings and generating structured report',
    status: 'running',
  })

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

  ctx.onProgress?.({
    actionId: 'synthesize-report',
    integration: 'system',
    label: 'Research report ready',
    detail: `${report.findings?.length ?? 0} findings across ${report.integrationsCovered?.length ?? 0} integrations`,
    status: 'complete',
  })

  return report
}

function inferIntegrationFromPurpose(
  purpose: string,
  availableIntegrations: string[],
): AgentActionIntegration {
  const lower = purpose.toLowerCase()
  for (const type of availableIntegrations) {
    if (lower.includes(type)) return type as AgentActionIntegration
  }
  if (lower.includes('commit') || lower.includes('pull request') || lower.includes('pr') || lower.includes('repo'))
    return 'github'
  if (lower.includes('session') || lower.includes('pageview') || lower.includes('rage'))
    return 'posthog'
  if (lower.includes('error') || lower.includes('issue') || lower.includes('exception'))
    return 'sentry'
  if (lower.includes('trace') || lower.includes('run') || lower.includes('token'))
    return 'langsmith'
  if (lower.includes('experiment') || lower.includes('score'))
    return 'braintrust'
  return 'system'
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
