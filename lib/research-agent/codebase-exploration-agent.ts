import { tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { model } from '@/lib/ai'
import { generateText, getLangSmithTracingClient } from '@/lib/langsmith-ai'
import { traceable } from 'langsmith/traceable'
import { getInstallationOctokit } from '@/lib/github'
import {
  buildFilteredRepoPaths,
  filterPaths,
  getTextFileContent,
  parseRepoFullName,
  suggestImportantPaths,
  DEFAULT_MAX_LIST_PATHS,
  DEFAULT_MAX_PATH_MATCHES,
} from '@/lib/github-repo-explorer'
import { type CodebaseExplorationResult, emptyCodebaseExploration } from './types'

const lsClient = getLangSmithTracingClient()

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function runCodebaseExplorationAgent(input: {
  installationId: number
  repoFullName: string
}): Promise<CodebaseExplorationResult> {
  const maxSteps = envInt('RESEARCH_CODEBASE_MAX_STEPS', 32)

  const parsedRef = parseRepoFullName(input.repoFullName)
  if (!parsedRef) {
    return emptyCodebaseExploration({
      summary: 'Invalid repository name (expected owner/repo).',
      truncationWarnings: ['Could not parse GITHUB_REPOS.'],
    })
  }
  const ref = parsedRef

  const octokit = await getInstallationOctokit(input.installationId)

  let cachedPaths: string[] | null = null
  let cachedBranch: string | null = null
  let treeWarnings: string[] = []
  let treeTruncated = false

  async function ensureTree(): Promise<void> {
    if (cachedPaths) return
    const built = await buildFilteredRepoPaths(octokit, ref)
    cachedPaths = built.paths
    cachedBranch = built.defaultBranch
    treeTruncated = built.truncated
    treeWarnings = built.warnings
  }

  const toolSteps: { tool: string; detail: string }[] = []

  const getRefTool = tool({
    description: 'Get the default branch name for the repository.',
    inputSchema: z.object({}),
    execute: async () => {
      toolSteps.push({ tool: 'get_repo_ref', detail: 'default branch' })
      await ensureTree()
      return {
        defaultBranch: cachedBranch,
        pathCount: cachedPaths?.length ?? 0,
        treeTruncatedFromApi: treeTruncated,
        warnings: treeWarnings,
      }
    },
  })

  const listPathsTool = tool({
    description:
      'List file paths in the repo. Optionally filter by directory prefix, substring, or file extension (e.g. ".tsx"). Results are capped.',
    inputSchema: z.object({
      prefix: z.string().optional().describe('Only paths under this prefix (e.g. app or src)'),
      substring: z.string().optional().describe('Path must contain this substring'),
      globSuffix: z.string().optional().describe('File extension such as .tsx or tsx'),
      maxResults: z.number().optional().describe(`Max paths (default ${DEFAULT_MAX_LIST_PATHS})`),
    }),
    execute: async (args) => {
      toolSteps.push({
        tool: 'list_repo_paths',
        detail: [args.prefix, args.substring, args.globSuffix].filter(Boolean).join(' ') || 'all',
      })
      await ensureTree()
      const maxR = args.maxResults ?? DEFAULT_MAX_LIST_PATHS
      const { paths, truncated } = filterPaths(cachedPaths ?? [], {
        prefix: args.prefix,
        substring: args.substring,
        globSuffix: args.globSuffix,
        maxResults: Math.min(maxR, DEFAULT_MAX_LIST_PATHS),
      })
      return {
        pathCount: paths.length,
        truncated,
        paths,
      }
    },
  })

  const readFileTool = tool({
    description: 'Read a text file from the repository at the given path (UTF-8).',
    inputSchema: z.object({
      path: z.string().describe('Repository-relative path to the file'),
    }),
    execute: async ({ path }: { path: string }) => {
      toolSteps.push({ tool: 'get_file_content', detail: path })
      await ensureTree()
      const branch = cachedBranch ?? 'HEAD'
      const result = await getTextFileContent(
        octokit,
        ref,
        path,
        branch,
        Number.POSITIVE_INFINITY,
      )
      if (!result.ok) {
        return { ok: false as const, path, error: result.error }
      }
      return {
        ok: true as const,
        path,
        truncated: result.truncated,
        size: result.size,
        content: result.content,
      }
    },
  })

  const searchPathsTool = tool({
    description: 'Search indexed paths by substring (case-insensitive). Returns up to maxMatches paths.',
    inputSchema: z.object({
      query: z.string().min(1),
      maxMatches: z.number().optional(),
    }),
    execute: async ({ query, maxMatches }: { query: string; maxMatches?: number }) => {
      toolSteps.push({ tool: 'search_repo_paths', detail: query })
      await ensureTree()
      const q = query.toLowerCase()
      const cap = Math.min(maxMatches ?? DEFAULT_MAX_PATH_MATCHES, DEFAULT_MAX_PATH_MATCHES)
      const hits = (cachedPaths ?? []).filter((p) => p.toLowerCase().includes(q)).slice(0, cap)
      return {
        matchCount: hits.length,
        truncated: (cachedPaths ?? []).filter((p) => p.toLowerCase().includes(q)).length > hits.length,
        paths: hits,
      }
    },
  })

  const suggestPathsTool = tool({
    description:
      'Get a short list of likely-important paths (configs, app routes, README) to prioritize reading.',
    inputSchema: z.object({}),
    execute: async () => {
      toolSteps.push({ tool: 'suggest_important_paths', detail: 'heuristic' })
      await ensureTree()
      const suggested = suggestImportantPaths(cachedPaths ?? [])
      return { suggestedPaths: suggested }
    },
  })

  const finishSchema = z.object({
    summary: z.string(),
    architecture: z.string(),
    inferredUserFlows: z.array(z.string()),
    testingImplications: z.string(),
    keyPathsExamined: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']),
    truncationWarnings: z.array(z.string()),
  })

  const finishTool = tool({
    description:
      'Call when you have enough understanding of the codebase to inform QA. Provide structured fields.',
    inputSchema: finishSchema,
    execute: async (payload) => {
      toolSteps.push({ tool: 'finish_codebase_exploration', detail: 'done' })
      return { finished: true, payload }
    },
  })

  const system = `You are an expert software architect and QA strategist exploring a single GitHub repository: ${input.repoFullName}.

Your job: use the tools repeatedly to build a deep understanding of how the application is structured and what user-facing flows exist, so UI testing can be planned effectively.

Rules:
- Prefer exploring app/, src/, pages/, packages/, and root config files (package.json, next.config.*, vite.config.*, README).
- Read enough representative files to understand routing, auth, forms, and critical user journeys.
- Skip binary assets and dependency folders (already filtered from listings).
- When satisfied, you MUST call finish_codebase_exploration with a complete structured summary.
- If you cannot fully explore (API errors, huge repo), still finish with lower confidence and explain in truncationWarnings.`

  const userMsg = `Explore ${input.repoFullName} thoroughly using the tools. Map architecture, infer primary user flows from routes/pages/components, and note testing implications (auth, payments, forms, edge cases). Finish with finish_codebase_exploration.`

  const exploration = await generateText({
    model,
    system,
    messages: [{ role: 'user', content: userMsg }],
    tools: {
      get_repo_ref: getRefTool,
      list_repo_paths: listPathsTool,
      get_file_content: readFileTool,
      search_repo_paths: searchPathsTool,
      suggest_important_paths: suggestPathsTool,
      finish_codebase_exploration: finishTool,
    },
    stopWhen: stepCountIs(maxSteps),
  })

  let finished: CodebaseExplorationResult | null = null
  for (const step of exploration.steps) {
    for (const tr of step.toolResults) {
      if (tr.toolName !== 'finish_codebase_exploration') continue
      const out = tr.output as { finished?: boolean; payload?: z.infer<typeof finishSchema> }
      if (out?.payload && typeof out.payload === 'object') {
        finished = {
          ...out.payload,
          toolStepsUsed: toolSteps.length,
        }
      }
    }
  }

  if (finished) {
    const mergedWarnings = [...(finished.truncationWarnings ?? [])]
    if (treeWarnings.length) mergedWarnings.push(...treeWarnings)
    if (treeTruncated) mergedWarnings.push('GitHub tree API marked truncated=true.')
    return {
      ...finished,
      truncationWarnings: mergedWarnings,
      toolStepsUsed: toolSteps.length,
    }
  }

  return emptyCodebaseExploration({
    summary: `Codebase exploration did not finish before step limit (${maxSteps}). Partial understanding only.`,
    architecture: 'Unknown — agent did not call finish_codebase_exploration.',
    inferredUserFlows: [],
    testingImplications: 'Re-run research or increase RESEARCH_CODEBASE_MAX_STEPS.',
    keyPathsExamined: toolSteps.filter((t) => t.tool === 'get_file_content').map((t) => t.detail),
    confidence: 'low',
    truncationWarnings: [
      `Stopped after ${maxSteps} steps without finish_codebase_exploration.`,
      ...treeWarnings,
    ],
    toolStepsUsed: toolSteps.length,
  })
}

export const tracedRunCodebaseExplorationAgent = traceable(runCodebaseExplorationAgent, {
  name: 'verona_codebase_exploration_agent',
  ...(lsClient ? { client: lsClient } : {}),
  processInputs: (i) => ({ repoFullName: i.repoFullName, installationId: i.installationId }),
  processOutputs: (o) => ({
    confidence: o.confidence,
    keyPathsCount: o.keyPathsExamined.length,
    warningsCount: o.truncationWarnings.length,
  }),
})
