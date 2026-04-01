const DEFAULT_LANGSMITH_API_URL = "https://api.smith.langchain.com"

export interface LangSmithConfig {
  apiKey: string
  apiUrl?: string
}

export interface LangSmithProject {
  id: string
  name: string
}

export interface LangSmithRun {
  id: string
  name: string
  runType: string
  status: string
  error?: string
  startTime: string
  endTime?: string
  latencyMs?: number
  totalTokens?: number
  promptTokens?: number
  completionTokens?: number
}

function getBaseUrl(config: LangSmithConfig): string {
  return (config.apiUrl || DEFAULT_LANGSMITH_API_URL).replace(/\/$/, "")
}

function headers(apiKey: string): Record<string, string> {
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  }
}

export async function validateLangSmithConnection(
  config: LangSmithConfig,
): Promise<boolean> {
  const base = getBaseUrl(config)
  try {
    const response = await fetch(`${base}/api/v1/sessions?limit=1`, {
      headers: headers(config.apiKey),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function listProjects(
  config: LangSmithConfig,
): Promise<LangSmithProject[]> {
  const base = getBaseUrl(config)
  const response = await fetch(`${base}/api/v1/sessions?limit=100`, {
    headers: headers(config.apiKey),
  })

  if (!response.ok) {
    throw new Error(`LangSmith API error: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as Array<Record<string, unknown>>
  return data.map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
  }))
}

export async function fetchRecentRuns(
  config: LangSmithConfig,
  projectName?: string,
  sinceMinutes: number = 10,
): Promise<LangSmithRun[]> {
  const base = getBaseUrl(config)
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString()

  const filterBody: Record<string, unknown> = {
    filter: `gte(start_time, "${since}")`,
    limit: 50,
  }

  if (projectName) {
    filterBody.session_name = projectName
  }

  const response = await fetch(`${base}/api/v1/runs/query`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify(filterBody),
  })

  if (!response.ok) {
    throw new Error(`LangSmith runs query error: ${response.status}`)
  }

  const data = (await response.json()) as { runs?: Array<Record<string, unknown>> }
  return (data.runs ?? []).map(mapRun)
}

export async function fetchFailedRuns(
  config: LangSmithConfig,
  projectName?: string,
  sinceMinutes: number = 10,
): Promise<LangSmithRun[]> {
  const base = getBaseUrl(config)
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString()

  const filterBody: Record<string, unknown> = {
    filter: `and(gte(start_time, "${since}"), eq(status, "error"))`,
    limit: 50,
  }

  if (projectName) {
    filterBody.session_name = projectName
  }

  const response = await fetch(`${base}/api/v1/runs/query`, {
    method: "POST",
    headers: headers(config.apiKey),
    body: JSON.stringify(filterBody),
  })

  if (!response.ok) {
    throw new Error(`LangSmith failed runs query error: ${response.status}`)
  }

  const data = (await response.json()) as { runs?: Array<Record<string, unknown>> }
  return (data.runs ?? []).map(mapRun)
}

function mapRun(run: Record<string, unknown>): LangSmithRun {
  const startTime = String(run.start_time ?? "")
  const endTime = run.end_time ? String(run.end_time) : undefined
  let latencyMs: number | undefined
  if (startTime && endTime) {
    latencyMs = new Date(endTime).getTime() - new Date(startTime).getTime()
  }

  const totalTokens = run.total_tokens as number | undefined
  const promptTokens = run.prompt_tokens as number | undefined
  const completionTokens = run.completion_tokens as number | undefined

  return {
    id: String(run.id ?? ""),
    name: String(run.name ?? ""),
    runType: String(run.run_type ?? ""),
    status: String(run.status ?? ""),
    error: run.error ? String(run.error) : undefined,
    startTime,
    endTime,
    latencyMs,
    totalTokens: totalTokens ?? undefined,
    promptTokens: promptTokens ?? undefined,
    completionTokens: completionTokens ?? undefined,
  }
}
