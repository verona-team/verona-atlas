const DEFAULT_POSTHOG_HOST = "https://us.posthog.com"

export interface PostHogConfig {
  apiKey: string
  projectId: string
  apiHost?: string
}

interface PostHogQueryResponse {
  results?: unknown[]
}

interface PostHogSessionRecordingsResponse {
  results?: unknown[]
}

function getHost(config: PostHogConfig): string {
  return (config.apiHost || DEFAULT_POSTHOG_HOST).replace(/\/$/, "")
}

export async function validatePostHogConnection(config: PostHogConfig): Promise<boolean> {
  const host = getHost(config)
  const response = await fetch(`${host}/api/projects/${config.projectId}/`, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  })
  return response.ok
}

export async function fetchSessionRecordings(
  config: PostHogConfig,
  limit: number = 50,
): Promise<unknown[]> {
  const host = getHost(config)
  const response = await fetch(
    `${host}/api/projects/${config.projectId}/session_recordings/?limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(`PostHog API error: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as PostHogSessionRecordingsResponse
  return data.results ?? []
}

export async function fetchErrorEvents(
  config: PostHogConfig,
  sinceDays: number = 7,
): Promise<unknown[]> {
  const host = getHost(config)
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]

  const response = await fetch(`${host}/api/projects/${config.projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: `SELECT properties.$current_url, properties.$exception_type, properties.$exception_message, count() as count 
                  FROM events 
                  WHERE event = '$exception' AND timestamp > '${dateFrom}' 
                  GROUP BY properties.$current_url, properties.$exception_type, properties.$exception_message 
                  ORDER BY count DESC 
                  LIMIT 50`,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`PostHog query error: ${response.status}`)
  }

  const data = (await response.json()) as PostHogQueryResponse
  return data.results ?? []
}

export async function fetchTopPages(
  config: PostHogConfig,
  sinceDays: number = 7,
): Promise<unknown[]> {
  const host = getHost(config)
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]

  const response = await fetch(`${host}/api/projects/${config.projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: `SELECT properties.$current_url as url, count() as pageviews, count(distinct distinct_id) as unique_users
                  FROM events 
                  WHERE event = '$pageview' AND timestamp > '${dateFrom}'
                  GROUP BY url
                  ORDER BY pageviews DESC 
                  LIMIT 30`,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`PostHog top pages query error: ${response.status}`)
  }

  const data = (await response.json()) as PostHogQueryResponse
  return data.results ?? []
}

export interface PostHogRealtimeEvent {
  event: string
  timestamp: string
  distinctId: string
  properties: Record<string, unknown>
}

export async function fetchRealtimeErrors(
  config: PostHogConfig,
  sinceMinutes: number = 5,
): Promise<PostHogRealtimeEvent[]> {
  const host = getHost(config)
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString()

  const response = await fetch(`${host}/api/projects/${config.projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: `SELECT event, timestamp, distinct_id,
                  properties.$current_url as url,
                  properties.$exception_type as exception_type,
                  properties.$exception_message as exception_message
                FROM events
                WHERE event = '$exception' AND timestamp > '${since}'
                ORDER BY timestamp DESC
                LIMIT 50`,
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`PostHog realtime query error: ${response.status}`)
  }

  const data = (await response.json()) as PostHogQueryResponse
  return (data.results ?? []).map((row: unknown) => {
    const r = row as string[]
    return {
      event: r[0] ?? "$exception",
      timestamp: r[1] ?? "",
      distinctId: r[2] ?? "",
      properties: {
        url: r[3],
        exception_type: r[4],
        exception_message: r[5],
      },
    }
  })
}
