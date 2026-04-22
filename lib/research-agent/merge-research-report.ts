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

export function mergeIntegrationAndCodebase(
  integration: IntegrationResearchReport,
  codebase: CodebaseExplorationResult,
): ResearchReport {
  const codeFindings: ResearchFinding[] = []

  if (codebase.architecture.trim()) {
    codeFindings.push({
      source: 'github_code',
      category: 'codebase_structure',
      details: codebase.architecture,
      severity: 'medium',
      rawData: JSON.stringify({
        confidence: codebase.confidence,
        keyPathsExamined: codebase.keyPathsExamined,
      }),
    })
  }

  if (codebase.testingImplications.trim()) {
    codeFindings.push({
      source: 'github_code',
      category: 'test_gaps',
      details: codebase.testingImplications,
      severity: 'high',
    })
  }

  if (codebase.inferredUserFlows.length > 0) {
    codeFindings.push({
      source: 'github_code',
      category: 'user_behavior',
      details: `Inferred user-visible flows from the repository: ${codebase.inferredUserFlows.join('; ')}`,
      severity: 'medium',
    })
  }

  const allFindings = [...integration.findings, ...codeFindings]

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
  const summary = summaryParts.filter(Boolean).join('\n\n')

  const integrationsSkipped = dedupeStrings([...integration.integrationsSkipped])

  return {
    summary,
    findings: allFindings,
    recommendedFlows,
    integrationsCovered: dedupeStrings([
      ...integration.integrationsCovered,
      'github_code',
    ]),
    integrationsSkipped,
    codebaseExploration: codebase,
  }
}
