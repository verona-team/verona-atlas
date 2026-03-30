const POSTHOG_API_BASE = "https://app.posthog.com"

export interface PostHogConfig {
  apiKey: string
  projectId: string
}

interface PostHogQueryResponse {
  results?: unknown[]
}

interface PostHogSessionRecordingsResponse {
  results?: unknown[]
}

export async function validatePostHogConnection(config: PostHogConfig): Promise<boolean> {
  const response = await fetch(`${POSTHOG_API_BASE}/api/projects/${config.projectId}/`, {
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
  const response = await fetch(
    `${POSTHOG_API_BASE}/api/projects/${config.projectId}/session_recordings/?limit=${limit}`,
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
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]

  const response = await fetch(`${POSTHOG_API_BASE}/api/projects/${config.projectId}/query/`, {
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
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0]

  const response = await fetch(`${POSTHOG_API_BASE}/api/projects/${config.projectId}/query/`, {
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
    throw new Error(`PostHog query error: ${response.status}`)
  }

  const data = (await response.json()) as PostHogQueryResponse
  return data.results ?? []
}
