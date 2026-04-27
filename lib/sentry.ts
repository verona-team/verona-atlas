const SENTRY_API_BASE = "https://sentry.io/api/0"

export interface SentryConfig {
  authToken: string
  organizationSlug: string
  projectSlug: string
}

export interface SentryIssue {
  id: string
  title: string
  culprit: string
  count: string
  firstSeen: string
  lastSeen: string
  level: string
  status: string
  permalink: string
}

export interface SentryAccessibleProject {
  organizationSlug: string
  projectSlug: string
  projectName: string
}

export class SentryAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SentryAuthError'
  }
}

export interface SentryEvent {
  eventID: string
  title: string
  message: string
  level: string
  timestamp: string
  tags: Array<{ key: string; value: string }>
  url?: string
}

function headers(authToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
  }
}

// Sentry uses GitHub-style Link headers for cursor pagination, with an extra
// `results="true|false"` attribute on each rel — `rel="next"` is always
// present, but only points at a real next page when `results="true"`. This
// returns the next-page URL only when there's actually more to fetch.
function parseSentryNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  // Each Link entry looks like:
  //   <https://sentry.io/...?cursor=...>; rel="next"; results="true"; cursor="..."
  // Multiple entries are comma-separated.
  for (const entry of linkHeader.split(',')) {
    const match = entry.match(/<([^>]+)>\s*;\s*(.+)$/)
    if (!match) continue
    const [, url, rest] = match
    const isNext = /\brel="next"/.test(rest)
    const hasResults = /\bresults="true"/.test(rest)
    if (isNext && hasResults) return url
  }
  return null
}

// Hard cap on pagination so a misbehaving Sentry response (or an org with an
// implausible number of projects) can't spin this into a runaway loop. 10
// pages at the default page size of 100 covers 1000 projects, which is well
// past anything the picker would meaningfully render anyway.
const MAX_PROJECT_PAGES = 10

// Lists every project the auth token can see, paired with its organization
// slug. Used by the connect flow so users only paste a token and pick from a
// list, instead of typing slugs by hand. Follows Sentry's Link-header
// pagination so orgs with more than one page of projects aren't silently
// truncated. Throws SentryAuthError on 401/403 so the API route can return
// a clear "bad token" message rather than a generic failure.
export async function fetchAccessibleProjects(
  authToken: string,
): Promise<SentryAccessibleProject[]> {
  const collected: Array<Record<string, unknown>> = []
  let nextUrl: string | null = `${SENTRY_API_BASE}/projects/`
  let pages = 0

  while (nextUrl && pages < MAX_PROJECT_PAGES) {
    const response: Response = await fetch(nextUrl, { headers: headers(authToken) })

    if (response.status === 401 || response.status === 403) {
      throw new SentryAuthError(
        'Sentry rejected the auth token. Check the token and that it has project:read scope.',
      )
    }

    if (!response.ok) {
      throw new Error(`Sentry API error: ${response.status} ${response.statusText}`)
    }

    const page = (await response.json()) as Array<Record<string, unknown>>
    collected.push(...page)
    nextUrl = parseSentryNextPageUrl(response.headers.get('Link'))
    pages += 1
  }

  return collected
    .map((project) => {
      const organization = project.organization as Record<string, unknown> | undefined
      const orgSlug = organization?.slug
      const projSlug = project.slug
      if (typeof orgSlug !== 'string' || typeof projSlug !== 'string') return null
      return {
        organizationSlug: orgSlug,
        projectSlug: projSlug,
        projectName:
          typeof project.name === 'string' && project.name.length > 0
            ? project.name
            : projSlug,
      }
    })
    .filter((p): p is SentryAccessibleProject => p !== null)
}

export async function validateSentryConnection(config: SentryConfig): Promise<boolean> {
  const response = await fetch(
    `${SENTRY_API_BASE}/projects/${encodeURIComponent(config.organizationSlug)}/${encodeURIComponent(config.projectSlug)}/`,
    { headers: headers(config.authToken) },
  )
  return response.ok
}

export async function fetchRecentIssues(
  config: SentryConfig,
  sinceDays: number = 7,
): Promise<SentryIssue[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  const params = new URLSearchParams({
    query: "is:unresolved",
    sort: "date",
    statsPeriod: `${sinceDays * 24}h`,
  })

  const response = await fetch(
    `${SENTRY_API_BASE}/projects/${encodeURIComponent(config.organizationSlug)}/${encodeURIComponent(config.projectSlug)}/issues/?${params}`,
    { headers: headers(config.authToken) },
  )

  if (!response.ok) {
    throw new Error(`Sentry API error: ${response.status} ${response.statusText}`)
  }

  const issues = await response.json()
  return (issues as Array<Record<string, unknown>>).slice(0, 50).map((issue) => ({
    id: String(issue.id),
    title: String(issue.title ?? ""),
    culprit: String(issue.culprit ?? ""),
    count: String(issue.count ?? "0"),
    firstSeen: String(issue.firstSeen ?? ""),
    lastSeen: String(issue.lastSeen ?? ""),
    level: String(issue.level ?? "error"),
    status: String(issue.status ?? "unresolved"),
    permalink: String(issue.permalink ?? ""),
  }))
}

export async function fetchRecentEvents(
  config: SentryConfig,
  sinceMinutes: number = 5,
): Promise<SentryEvent[]> {
  const response = await fetch(
    `${SENTRY_API_BASE}/projects/${encodeURIComponent(config.organizationSlug)}/${encodeURIComponent(config.projectSlug)}/events/?full=true`,
    { headers: headers(config.authToken) },
  )

  if (!response.ok) {
    throw new Error(`Sentry API error: ${response.status} ${response.statusText}`)
  }

  const events = (await response.json()) as Array<Record<string, unknown>>
  const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000)

  return events
    .filter((e) => new Date(String(e.dateCreated ?? e.timestamp ?? "")) >= cutoff)
    .slice(0, 50)
    .map((e) => {
      const tags = Array.isArray(e.tags)
        ? (e.tags as Array<{ key: string; value: string }>)
        : []
      const urlTag = tags.find((t) => t.key === "url")
      return {
        eventID: String(e.eventID ?? ""),
        title: String(e.title ?? ""),
        message: String(e.message ?? e.title ?? ""),
        level: String(e.level ?? "error"),
        timestamp: String(e.dateCreated ?? e.timestamp ?? ""),
        tags,
        url: urlTag?.value,
      }
    })
}

export async function fetchIssueEvents(
  config: SentryConfig,
  issueId: string,
  limit: number = 10,
): Promise<unknown[]> {
  const response = await fetch(
    `${SENTRY_API_BASE}/issues/${encodeURIComponent(issueId)}/events/?limit=${limit}`,
    { headers: headers(config.authToken) },
  )

  if (!response.ok) {
    throw new Error(`Sentry API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}
