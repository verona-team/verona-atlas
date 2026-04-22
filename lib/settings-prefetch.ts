'use client'

/**
 * In-memory prefetch cache for the settings overlay. The chat page starts a
 * background fetch of `/api/projects/:id` and `/api/projects/:id/integrations`
 * while the user is still in the chat, so when they click "Settings" the
 * overlay renders with data already resolved — avoiding the multi-second
 * blank-loading state that previously gated the panel on a cold fetch.
 */

type IntegrationData = {
  id: string
  type: string
  status: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

type ProjectData = {
  id: string
  name: string
}

type CacheEntry = {
  project: ProjectData | null
  integrations: IntegrationData[]
  /** Monotonic version bumped on every successful fetch — lets consumers
   *  re-render (via a subscription) when fresh data lands. */
  version: number
  fetchedAt: number
  inflight: Promise<void> | null
}

type Subscriber = () => void

const entries = new Map<string, CacheEntry>()
const subscribers = new Map<string, Set<Subscriber>>()

function getOrInit(projectId: string): CacheEntry {
  let e = entries.get(projectId)
  if (!e) {
    e = {
      project: null,
      integrations: [],
      version: 0,
      fetchedAt: 0,
      inflight: null,
    }
    entries.set(projectId, e)
  }
  return e
}

function notify(projectId: string) {
  const subs = subscribers.get(projectId)
  if (!subs) return
  for (const fn of subs) fn()
}

export function getSettingsCache(projectId: string): CacheEntry | undefined {
  return entries.get(projectId)
}

export function subscribeSettingsCache(projectId: string, fn: Subscriber): () => void {
  let subs = subscribers.get(projectId)
  if (!subs) {
    subs = new Set()
    subscribers.set(projectId, subs)
  }
  subs.add(fn)
  return () => {
    subs!.delete(fn)
    if (subs!.size === 0) subscribers.delete(projectId)
  }
}

/**
 * Fetch and cache settings data for `projectId`. Coalesces concurrent calls
 * into a single in-flight request. When `force` is false, a recent fetch
 * (<2s old) short-circuits.
 */
export async function prefetchSettings(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const entry = getOrInit(projectId)
  if (entry.inflight) return entry.inflight
  if (!opts.force && entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < 2_000) {
    return
  }

  const p = (async () => {
    try {
      const [projRes, intRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/projects/${projectId}/integrations`),
      ])
      if (projRes.ok) {
        const projData = (await projRes.json()) as ProjectData
        entry.project = projData
      }
      if (intRes.ok) {
        const intData = (await intRes.json()) as { integrations?: IntegrationData[] }
        entry.integrations = intData.integrations ?? []
      }
      entry.fetchedAt = Date.now()
      entry.version += 1
      notify(projectId)
    } catch {
      /* swallow — the settings panel will retry on mount */
    } finally {
      entry.inflight = null
    }
  })()

  entry.inflight = p
  return p
}

export function invalidateSettingsCache(projectId: string) {
  const e = entries.get(projectId)
  if (!e) return
  e.fetchedAt = 0
}
