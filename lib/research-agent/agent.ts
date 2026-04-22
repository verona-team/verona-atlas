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

async function runPreflightScripts(
  ctx: AgentContext,
): Promise<Record<string, { success: boolean; data: string; error?: string }>> {
  const integrationList = Object.keys(ctx.integrationDocs)
  const results: Record<string, { success: boolean; data: string; error?: string }> = {}

  const tasks = integrationList
    .filter((type) => PREFLIGHT_SCRIPTS[type])
    .map(async (type) => {
      try {
        const script = PREFLIGHT_SCRIPTS[type](ctx.integrationEnvVars)
        const result = await executeInSandbox(ctx.sandbox, script, ctx.integrationEnvVars)
        results[type] = {
          success: result.exitCode === 0,
          data: result.stdout,
          error: result.exitCode !== 0 ? result.stderr : undefined,
        }
      } catch (e) {
        results[type] = { success: false, data: '', error: String(e) }
      }
    })

  for (const task of tasks) {
    await task
  }

  return results
}

async function runResearchLoopCore(ctx: AgentContext): Promise<IntegrationResearchReport> {
  const integrationList = Object.keys(ctx.integrationDocs)

  const preflightResults = await runPreflightScripts(ctx)

  const preflightSummary = Object.entries(preflightResults)
    .map(([type, result]) => {
      if (result.success) {
        return `## ${type.toUpperCase()} Preflight Data (auto-collected)\n\n\`\`\`json\n${result.data}\n\`\`\``
      }
      return `## ${type.toUpperCase()} Preflight Data\n\nFailed: ${result.error ?? 'unknown error'}. Use execute_code to investigate manually.`
    })
    .join('\n\n---\n\n')

  const envVarDocs = Object.entries(ctx.integrationEnvVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  const apiDocs = Object.entries(ctx.integrationDocs)
    .map(([type, docs]) => `## ${type.toUpperCase()} API Documentation\n\n${docs}`)
    .join('\n\n---\n\n')

  const systemPrompt = `You are a QA research agent investigating connected integrations for ${ctx.appUrl}. Your goal: surface specific, evidence-backed signals a human QA lead could turn into UI test flows.

Connected integrations: ${integrationList.join(', ')}

# Execution environment

- You invoke code via the \`execute_code\` tool. It runs JavaScript (ES modules, Node 24, built-in \`fetch\`) in a sandbox with network access only to the allowed integration hosts.
- Authentication headers are auto-injected for allowed hosts. Do NOT set Authorization headers yourself.
- Run code executions SEQUENTIALLY (one at a time) — parallel calls collide on sandbox stdout.
- Use \`console.log(JSON.stringify(...))\` to return data. Keep each call focused on one question.

Available env vars (use for project IDs, org slugs, etc.):
${envVarDocs}

# Investigation approach

1. Preflight data (below) has already collected the obvious first-layer facts for each integration. Read it first.
2. Then use \`execute_code\` ONLY to go deeper: drill into specific findings, correlate across sources, fill gaps. Do NOT re-fetch what preflight already provides.
3. Favour a few targeted, well-chosen follow-ups over many shallow queries. If preflight is already sufficient for a given integration, move on.

# Per-integration drill-in suggestions

- GitHub: biggest recent PRs → which files/modules; patterns across bug-fix commits; open issues tagged with bugs or regressions.
- PostHog: top rage-click URLs → pull a matching session recording's clickstream; repeated exception messages → affected URLs + user counts.
- Sentry: top unresolved issues → stack traces + affected URLs; events in the last 24h to catch fresh regressions.
- LangSmith: error runs → error messages; latency outliers; which chains/prompts are failing.
- Braintrust: experiments with recent score regressions → which metric dropped.

# What "good" looks like

Every finding you surface should have at least one concrete anchor (commit SHA, PR #, URL path, error message, count, session ID) so a downstream reader can verify it.

When you have enough signal, stop calling tools. You'll then be asked for a structured report.`

  const researchGen = await generateText({
    model,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Investigate ${integrationList.join(', ')} for QA test planning signals on ${ctx.appUrl}.

## Preflight data (already collected — start here)

${preflightSummary}

## API reference (for your follow-up queries)

${apiDocs}

Drill into the most interesting signals the preflight surfaced. Correlate across integrations when it helps (e.g. a PostHog rage-click URL that matches a Sentry error, or a freshly merged PR that touches a page with rising error rates). Do NOT re-fetch what preflight already provides.`,
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
            const MAX_RETRIES = 2
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              try {
                const result = await executeInSandbox(ctx.sandbox, code, ctx.integrationEnvVars)
                if (result.exitCode !== 0 && attempt < MAX_RETRIES && isTransientError(result.stderr)) {
                  await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
                  continue
                }
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
              code: inputs.code ?? '',
            }),
            processOutputs: (out) => ({
              purpose: out.purpose,
              exitCode: out.exitCode,
              stdout: out.stdout ?? '',
              stderr: out.stderr ?? '',
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

  const { output: report } = await generateText({
    model,
    output: Output.object({ schema: integrationResearchReportSchema }),
    prompt: `Synthesize a structured QA research report from the investigation notes below. The report is the canonical handoff to a downstream flow-proposer; be specific and evidence-backed, not narrative.

App under test: ${ctx.appUrl}
Integrations investigated: ${integrationList.join(', ')}

# Output requirements

- \`summary\`: 3–6 sentences. Lead with the single biggest risk, then the next 1–2 themes. No preamble. No "this report covers…".
- \`findings\`: one entry per distinct, actionable signal. Each needs \`source\`, \`category\`, \`severity\`, a one- or two-sentence \`details\` that ends with a concrete anchor (commit SHA, PR #, URL, error count, session ID). Use \`rawData\` (JSON string) ONLY when the anchor doesn't fit naturally in prose (e.g. a list of commit SHAs); omit otherwise.
- \`recommendedFlows\`: short phrases naming user-facing flows a QA human could recognize ("Autosave under concurrent editing", "Magic-link expiration recovery"). Prefer 5–10 strong candidates over 20 weak ones. Each must be traceable to at least one finding.
- \`integrationsCovered\` / \`integrationsSkipped\`: honest account of what produced usable data vs what errored or returned nothing.

# Prioritization for recommended flows

1. Regressions on recently merged PRs — especially large diffs, bug-fix series, or infra overhauls.
2. Pages with concrete user pain (rage clicks, exceptions, drop-off).
3. High-traffic journeys that would be embarrassing to break.
4. AI/LLM features with failing runs or score regressions.

# Research notes

${researchNotes}`,
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
