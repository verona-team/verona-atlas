import type {
  CodebaseExplorationResult,
  IntegrationResearchReport,
  ResearchFinding,
  ResearchReport,
} from './types'

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of items) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function findCorrelations(
  findings: ResearchFinding[],
  codebase: CodebaseExplorationResult,
): ResearchFinding[] {
  const correlations: ResearchFinding[] = []

  const githubFindings = findings.filter((f) => f.source === 'github' && f.category === 'recent_changes')
  const errorFindings = findings.filter((f) =>
    (f.source === 'posthog' || f.source === 'sentry') &&
    (f.category === 'errors' || f.category === 'user_behavior'),
  )

  if (githubFindings.length > 0 && errorFindings.length > 0) {
    const changedAreas = githubFindings
      .map((f) => f.details.toLowerCase())
      .join(' ')

    const errorAreas = errorFindings
      .map((f) => f.details.toLowerCase())
      .join(' ')

    const sharedKeywords = ['sheet', 'outreach', 'campaign', 'signal', 'billing', 'credit', 'auth', 'login', 'search']
    const overlaps = sharedKeywords.filter(
      (kw) => changedAreas.includes(kw) && errorAreas.includes(kw),
    )

    if (overlaps.length > 0) {
      correlations.push({
        source: 'cross_integration',
        category: 'correlation',
        details: `Cross-integration correlation detected: recent GitHub code changes AND error signals/user friction both affect these areas: ${overlaps.join(', ')}. These areas should be prioritized for testing as they represent active development with observable user impact.`,
        severity: 'critical',
        rawData: JSON.stringify({ overlappingAreas: overlaps }),
      })
    }
  }

  const llmFindings = findings.filter(
    (f) => f.source === 'langsmith' || f.source === 'braintrust',
  )
  const llmRelatedFlows = codebase.inferredUserFlows.filter((flow) => {
    const lower = flow.toLowerCase()
    return lower.includes('ai') || lower.includes('agent') || lower.includes('llm') ||
      lower.includes('search') || lower.includes('outreach') || lower.includes('research')
  })
  if (llmFindings.length > 0 && llmRelatedFlows.length > 0) {
    const hasErrors = llmFindings.some(
      (f) => f.category === 'llm_failures' || f.details.toLowerCase().includes('error'),
    )
    if (hasErrors) {
      correlations.push({
        source: 'cross_integration',
        category: 'correlation',
        details: `LLM/AI errors detected in traces that map to these user-facing flows: ${llmRelatedFlows.slice(0, 3).join('; ')}. End-to-end testing of these AI-powered flows is recommended to verify error recovery and graceful degradation.`,
        severity: 'high',
      })
    }
  }

  return correlations
}

export function mergeIntegrationAndCodebase(
  integration: IntegrationResearchReport,
  codebase: CodebaseExplorationResult,
): ResearchReport {
  const codeFindings: ResearchFinding[] = []

  if (codebase.architecture.trim()) {
    codeFindings.push({
      source: 'github_code',
      category: 'codebase_structure',
      details: codebase.architecture.slice(0, 4000),
      severity: 'medium',
      rawData: JSON.stringify({
        confidence: codebase.confidence,
        keyPathsSample: codebase.keyPathsExamined.slice(0, 15),
      }),
    })
  }

  if (codebase.testingImplications.trim()) {
    codeFindings.push({
      source: 'github_code',
      category: 'test_gaps',
      details: codebase.testingImplications.slice(0, 4000),
      severity: 'high',
    })
  }

  if (codebase.inferredUserFlows.length > 0) {
    codeFindings.push({
      source: 'github_code',
      category: 'user_behavior',
      details: `Inferred user-visible flows from the repository: ${codebase.inferredUserFlows.slice(0, 12).join('; ')}`,
      severity: 'medium',
    })
  }

  const allFindings = [...integration.findings, ...codeFindings]
  const correlations = findCorrelations(allFindings, codebase)
  const mergedFindings = [...correlations, ...allFindings]

  const flowExtras = codebase.inferredUserFlows.map(
    (f) => `From codebase: ${f}`,
  )
  const recommendedFlows = dedupeStrings([
    ...integration.recommendedFlows,
    ...flowExtras,
  ]).slice(0, 20)

  const summaryParts = [integration.summary.trim()]
  if (codebase.summary.trim()) {
    summaryParts.push(
      `Repository analysis (${codebase.confidence} confidence): ${codebase.summary.trim()}`,
    )
  }
  if (correlations.length > 0) {
    summaryParts.push(
      `Cross-integration analysis identified ${correlations.length} correlation(s) between code changes and observed user/system issues.`,
    )
  }
  const summary = summaryParts.filter(Boolean).join('\n\n')

  const integrationsSkipped = dedupeStrings([...integration.integrationsSkipped])

  return {
    summary,
    findings: mergedFindings,
    recommendedFlows,
    integrationsCovered: dedupeStrings([
      ...integration.integrationsCovered,
      'github_code',
    ]),
    integrationsSkipped,
    codebaseExploration: codebase,
  }
}
