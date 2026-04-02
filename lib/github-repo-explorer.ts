/**
 * Bounded GitHub REST access for repository exploration (tree + file reads).
 * Used by the codebase exploration ReAct agent — all limits are server-enforced.
 */
import type { Octokit } from '@octokit/rest'

/** Max blob paths kept after filtering (not raw Git tree size). */
export const DEFAULT_MAX_TREE_NODES = 40_000
export const DEFAULT_MAX_LIST_PATHS = 400
export const DEFAULT_MAX_FILE_CHARS = 100_000
export const DEFAULT_MAX_PATH_MATCHES = 200

const SKIP_DIR_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  'coverage/',
  '.turbo/',
  'vendor/',
  '__pycache__/',
  '.venv/',
  'venv/',
]

const SKIP_FILE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.lock',
])

const PREFERRED_TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.css',
  '.scss',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.env',
  '.example',
  '.sql',
  '.graphql',
  '.rs',
  '.go',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.swift',
  '.vue',
  '.svelte',
])

export interface RepoRef {
  owner: string
  repo: string
}

export function parseRepoFullName(fullName: string): RepoRef | null {
  const parts = fullName.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  return { owner: parts[0], repo: parts[1] }
}

function shouldSkipPath(path: string): boolean {
  const lower = path.toLowerCase()
  for (const p of SKIP_DIR_PREFIXES) {
    if (lower.includes(`/${p}`) || lower.startsWith(p)) return true
  }
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot >= 0) {
    const ext = base.slice(dot).toLowerCase()
    if (SKIP_FILE_EXT.has(ext)) return true
  }
  return false
}

export interface TreeBuildResult {
  paths: string[]
  defaultBranch: string
  truncated: boolean
  totalNodesSeen: number
  warnings: string[]
}

/**
 * Load full recursive tree for the default branch, filter to plausible source paths.
 */
export async function buildFilteredRepoPaths(
  octokit: Octokit,
  ref: RepoRef,
  options?: { maxNodes?: number },
): Promise<TreeBuildResult> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_TREE_NODES
  const warnings: string[] = []

  const { data: repo } = await octokit.rest.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  })
  const defaultBranch = repo.default_branch ?? 'main'

  const { data: refData } = await octokit.rest.git.getRef({
    owner: ref.owner,
    repo: ref.repo,
    ref: `heads/${defaultBranch}`,
  })
  const commitSha = refData.object.sha

  const { data: commit } = await octokit.rest.git.getCommit({
    owner: ref.owner,
    repo: ref.repo,
    commit_sha: commitSha,
  })
  const treeSha = commit.tree.sha

  const { data: tree } = await octokit.rest.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: treeSha,
    recursive: 'true',
  })

  const truncated = tree.truncated === true
  if (truncated) {
    warnings.push(
      'GitHub returned a truncated tree — some paths may be missing. Prefer targeted reads under app/, src/, packages/.',
    )
  }

  const paths: string[] = []
  const rawTree = tree.tree ?? []
  const totalNodesSeen = rawTree.length
  for (const entry of rawTree) {
    if (entry.type !== 'blob' || !entry.path) continue
    if (shouldSkipPath(entry.path)) continue
    paths.push(entry.path)
    if (paths.length >= maxNodes) {
      warnings.push(`Stopped indexing after ${maxNodes} source-like paths (cap).`)
      break
    }
  }

  paths.sort((a, b) => a.localeCompare(b))

  return {
    paths,
    defaultBranch,
    truncated,
    totalNodesSeen,
    warnings,
  }
}

export function filterPaths(
  allPaths: string[],
  input: { prefix?: string; substring?: string; globSuffix?: string; maxResults?: number },
): { paths: string[]; truncated: boolean } {
  const max = input.maxResults ?? DEFAULT_MAX_LIST_PATHS
  let cur = allPaths

  if (input.prefix?.trim()) {
    const p = input.prefix.replace(/^\//, '')
    cur = cur.filter((x) => x === p || x.startsWith(`${p}/`))
  }
  if (input.substring?.trim()) {
    const s = input.substring.toLowerCase()
    cur = cur.filter((x) => x.toLowerCase().includes(s))
  }
  if (input.globSuffix?.trim()) {
    const suf = input.globSuffix.startsWith('.') ? input.globSuffix : `.${input.globSuffix}`
    cur = cur.filter((x) => x.toLowerCase().endsWith(suf.toLowerCase()))
  }

  const truncated = cur.length > max
  return { paths: cur.slice(0, max), truncated }
}

export async function getTextFileContent(
  octokit: Octokit,
  ref: RepoRef,
  path: string,
  gitRef: string,
  maxChars: number,
): Promise<
  | { ok: true; content: string; encoding: 'utf-8'; size: number; truncated: boolean }
  | { ok: false; error: string }
> {
  const normalized = path.replace(/^\/+/, '')
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: normalized,
      ref: gitRef,
    })

    if (Array.isArray(data)) {
      return { ok: false, error: 'Path is a directory, not a file' }
    }
    if (data.type !== 'file') {
      return { ok: false, error: 'Not a file' }
    }

    if (data.size > maxChars * 2) {
      return {
        ok: false,
        error: `File is too large (${data.size} bytes). Max approx ${maxChars} characters.`,
      }
    }

    if ('content' in data && data.encoding === 'base64' && data.content) {
      const buf = Buffer.from(data.content.replace(/\n/g, ''), 'base64')
      if (buf.includes(0)) {
        return { ok: false, error: 'Binary file — skipped' }
      }
      let text = buf.toString('utf8')
      const truncated = text.length > maxChars
      if (truncated) text = text.slice(0, maxChars)
      return { ok: true, content: text, encoding: 'utf-8', size: buf.length, truncated }
    }

    return { ok: false, error: 'Could not decode file content' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export function suggestImportantPaths(paths: string[]): string[] {
  const scored = paths.map((p) => {
    let score = 0
    const lower = p.toLowerCase()
    if (lower.includes('package.json')) score += 50
    if (lower.includes('readme')) score += 20
    if (lower.match(/(^|\/)app\//)) score += 15
    if (lower.match(/(^|\/)src\//)) score += 12
    if (lower.match(/(^|\/)pages\//)) score += 12
    if (lower.includes('routes')) score += 10
    if (lower.includes('next.config')) score += 8
    if (lower.includes('vite.config')) score += 8
    if (PREFERRED_TEXT_EXT.has(getExt(p))) score += 3
    return { p, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((x) => x.score > 0).slice(0, 25).map((x) => x.p)
}

function getExt(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  return base.slice(dot).toLowerCase()
}
