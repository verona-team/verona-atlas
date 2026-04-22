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

  const system = `You are an expert software architect and QA strategist exploring the GitHub repository ${input.repoFullName}. Your output will directly feed QA test planning for the deployed web app, so focus on what a user would actually do in the UI.

# Approach

1. Start with \`get_repo_ref\` to know the default branch, then \`suggest_important_paths\` for a high-signal entrypoint list.
2. Read README, package.json / framework config (next.config.*, vite.config.*, nuxt.config.*, astro.config.*, svelte.config.*) to identify the framework, router, and any monorepo layout. This disambiguates where routes/pages live.
3. Explore the routing surface: \`app/\`, \`src/app/\`, \`pages/\`, \`src/pages/\`, \`routes/\`, or framework equivalent. Read representative route files — don't read every file, read the ones that reveal distinct user journeys (auth, onboarding, core workflows, forms, payments, settings).
4. Skim middleware/guards, auth helpers, and API route handlers only insofar as they reveal user-visible behaviour. Skip pure utility and type-only files.
5. Binary assets and dependency folders are already filtered from listings.

# Efficiency

- Prefer listing + targeted reads over broad enumeration. One good read beats three skimmed ones.
- Stop exploring a path when returns diminish. You have a hard step budget — spend it where it reveals new flows, not to confirm what you already inferred.

# Finish

When you have enough to describe the app's real user journeys, call \`finish_codebase_exploration\`.
- \`summary\`: 3–5 sentences. What kind of app is this, what's its primary value to a user, and what is the dominant flow.
- \`architecture\`: stack + routing model + auth strategy + any notable patterns (monorepo, server actions, tRPC, etc.).
- \`inferredUserFlows\`: concrete, UI-level flows a user actually does — each phrased as a short action ("Sign in with magic link", "Create a new sheet and add columns"). Derive from routes/pages/components, not from tech.
- \`testingImplications\`: risks a QA human should prioritize given what you saw (auth surface area, payment flows, forms with complex validation, new or heavily churned modules, accessibility traps).
- \`keyPathsExamined\`: the files you actually read that most informed your answer.
- \`confidence\`: high / medium / low. Use low if you hit API errors, repo was truncated, or you didn't get to read a meaningful cross-section.
- \`truncationWarnings\`: honest list of gaps (e.g. "Could not read src/lib/payments — GitHub returned 404").

If you hit errors or a huge repo, still finish with lower confidence rather than leaving empty.`

  const userMsg = `Explore ${input.repoFullName} to map its real user-facing flows for QA planning. Use the tools iteratively — start from routes/pages, read enough representative files to infer the main journeys (auth, core workflow, forms, settings), and finish by calling \`finish_codebase_exploration\` with concrete inferredUserFlows and testingImplications.`

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
