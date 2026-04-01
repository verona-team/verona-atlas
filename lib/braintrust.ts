const DEFAULT_BRAINTRUST_API_URL = "https://api.braintrust.dev"

export interface BraintrustConfig {
  apiKey: string
  apiUrl?: string
}

export interface BraintrustProject {
  id: string
  name: string
}

export interface BraintrustLogEntry {
  id: string
  input: unknown
  output: unknown
  expected?: unknown
  scores?: Record<string, number>
  error?: string
  metadata?: Record<string, unknown>
  created: string
}

export interface BraintrustExperiment {
  id: string
  name: string
  projectId: string
  created: string
}

function getBaseUrl(config: BraintrustConfig): string {
  return (config.apiUrl || DEFAULT_BRAINTRUST_API_URL).replace(/\/$/, "")
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }
}

export async function validateBraintrustConnection(
  config: BraintrustConfig,
): Promise<boolean> {
  const base = getBaseUrl(config)
  try {
    const response = await fetch(`${base}/v1/project?limit=1`, {
      headers: headers(config.apiKey),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function listProjects(
  config: BraintrustConfig,
): Promise<BraintrustProject[]> {
  const base = getBaseUrl(config)
  const response = await fetch(`${base}/v1/project?limit=100`, {
    headers: headers(config.apiKey),
  })

  if (!response.ok) {
    throw new Error(`Braintrust API error: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as { objects?: Array<Record<string, unknown>> }
  return (data.objects ?? []).map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
  }))
}

export async function fetchRecentLogs(
  config: BraintrustConfig,
  projectId: string,
  sinceMinutes: number = 10,
): Promise<BraintrustLogEntry[]> {
  const base = getBaseUrl(config)
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString()

  const response = await fetch(`${base}/v1/project_logs/${encodeURIComponent(projectId)}/fetch`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify({
      filters: [
        {
          type: "path_lookup",
          path: ["created"],
          value: since,
        },
      ],
      limit: 50,
    }),
  })

  if (!response.ok) {
    throw new Error(`Braintrust logs query error: ${response.status}`)
  }

  const data = (await response.json()) as { events?: Array<Record<string, unknown>> }
  return (data.events ?? []).map(mapLogEntry)
}

export async function fetchExperimentResults(
  config: BraintrustConfig,
  experimentId: string,
  limit: number = 50,
): Promise<BraintrustLogEntry[]> {
  const base = getBaseUrl(config)

  const response = await fetch(
    `${base}/v1/experiment/${encodeURIComponent(experimentId)}/fetch`,
    {
      method: "POST",
      headers: headers(config.apiKey),
      body: JSON.stringify({ limit }),
    },
  )

  if (!response.ok) {
    throw new Error(`Braintrust experiment fetch error: ${response.status}`)
  }

  const data = (await response.json()) as { events?: Array<Record<string, unknown>> }
  return (data.events ?? []).map(mapLogEntry)
}

export async function fetchRecentExperiments(
  config: BraintrustConfig,
  projectId: string,
  limit: number = 10,
): Promise<BraintrustExperiment[]> {
  const base = getBaseUrl(config)

  const response = await fetch(
    `${base}/v1/experiment?project_id=${encodeURIComponent(projectId)}&limit=${limit}`,
    { headers: headers(config.apiKey) },
  )

  if (!response.ok) {
    throw new Error(`Braintrust experiments query error: ${response.status}`)
  }

  const data = (await response.json()) as { objects?: Array<Record<string, unknown>> }
  return (data.objects ?? []).map((e) => ({
    id: String(e.id ?? ""),
    name: String(e.name ?? ""),
    projectId: String(e.project_id ?? ""),
    created: String(e.created ?? ""),
  }))
}

function mapLogEntry(entry: Record<string, unknown>): BraintrustLogEntry {
  return {
    id: String(entry.id ?? ""),
    input: entry.input ?? null,
    output: entry.output ?? null,
    expected: entry.expected ?? undefined,
    scores: (entry.scores as Record<string, number>) ?? undefined,
    error: entry.error ? String(entry.error) : undefined,
    metadata: (entry.metadata as Record<string, unknown>) ?? undefined,
    created: String(entry.created ?? ""),
  }
}
