'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { RunStatusBadge } from '@/components/dashboard/run-status-badge'
import { PanelPage } from '@/components/dashboard/panel-page'
import { createClient } from '@/lib/supabase/client'

interface TestResult {
  id: string
  test_run_id: string
  test_template_id: string | null
  status: string
  duration_ms: number | null
  error_message: string | null
  screenshots: string[]
  console_logs: Record<string, unknown> | null
  network_errors: Record<string, unknown> | null
  ai_analysis: string | null
  created_at: string
  test_templates: { id: string; name: string } | null
}

interface TestRun {
  id: string
  project_id: string
  trigger: string
  status: string
  started_at: string | null
  completed_at: string | null
  summary: Record<string, unknown> | null
  created_at: string
}

export default function RunDetailPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const runId = params.runId as string

  const [run, setRun] = useState<TestRun | null>(null)
  const [results, setResults] = useState<TestResult[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedResult, setExpandedResult] = useState<string | null>(null)

  const fetchRunData = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${runId}`)
      if (response.ok) {
        const data = await response.json()
        setRun(data.run)
        setResults(data.results)
      }
    } catch {} finally { setLoading(false) }
  }, [runId])

  useEffect(() => { fetchRunData() }, [fetchRunData])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`test-run-${runId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'test_runs', filter: `id=eq.${runId}` },
        (payload) => { setRun(payload.new as TestRun); if (['completed', 'failed'].includes((payload.new as TestRun).status)) fetchRunData() })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'test_results', filter: `test_run_id=eq.${runId}` },
        () => { fetchRunData() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [runId, fetchRunData])

  if (loading) return (
    <PanelPage projectId={projectId} title="Run Details">
      <p className="text-sm text-muted-foreground py-8">Loading...</p>
    </PanelPage>
  )

  if (!run) return (
    <PanelPage projectId={projectId} title="Run Details">
      <p className="text-sm text-muted-foreground py-8">Run not found</p>
    </PanelPage>
  )

  const summary = run.summary as { total?: number; passed?: number; failed?: number; errors?: number; ai_analysis?: string } | null
  const duration = run.started_at && run.completed_at
    ? `${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
    : run.started_at ? 'Running...' : '—'

  return (
    <PanelPage projectId={projectId} title="Run Details">
      <div className="space-y-6">
        {/* Run header */}
        <div className="flex items-center gap-3">
          <RunStatusBadge status={run.status} />
          <span className="text-xs text-muted-foreground">{run.trigger}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{duration}</span>
          <span className="text-xs text-muted-foreground/50 ml-auto">{run.id.slice(0, 8)}</span>
        </div>

        {/* Summary stats */}
        {summary && typeof summary.total === 'number' && (
          <div className="flex gap-6 text-sm">
            <span>{summary.total} total</span>
            <span className="text-green-500">{summary.passed || 0} passed</span>
            <span className="text-red-500">{summary.failed || 0} failed</span>
            <span className="text-amber-500">{summary.errors || 0} errors</span>
          </div>
        )}

        {/* AI Analysis */}
        {summary?.ai_analysis && (
          <div>
            <h3 className="text-xs text-muted-foreground mb-2">AI Analysis</h3>
            <pre className="text-sm whitespace-pre-wrap text-foreground/70">{String(summary.ai_analysis)}</pre>
          </div>
        )}

        {/* Results */}
        <div>
          <h3 className="text-xs text-muted-foreground mb-3">Results ({results.length})</h3>
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {['pending', 'planning', 'running'].includes(run.status) ? 'Running...' : 'No results'}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {results.map((result) => (
                <div key={result.id}>
                  <button
                    className="flex items-center justify-between w-full py-3 text-left text-sm"
                    onClick={() => setExpandedResult(expandedResult === result.id ? null : result.id)}
                  >
                    <div className="flex items-center gap-3">
                      <span className={result.status === 'passed' ? 'text-green-500' : result.status === 'failed' ? 'text-red-500' : 'text-amber-500'}>
                        {result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '!'}
                      </span>
                      <span className="text-foreground/80">{result.test_templates?.name || 'Unknown'}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {result.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : ''}
                    </span>
                  </button>

                  {expandedResult === result.id && (
                    <div className="pb-4 pl-6 space-y-3 text-sm">
                      {result.error_message && (
                        <pre className="whitespace-pre-wrap text-red-500/80">{result.error_message}</pre>
                      )}
                      {result.ai_analysis && (
                        <pre className="whitespace-pre-wrap text-foreground/60">{result.ai_analysis}</pre>
                      )}
                      {result.console_logs && (
                        <pre className="whitespace-pre-wrap text-muted-foreground max-h-40 overflow-auto text-xs">
                          {JSON.stringify(result.console_logs, null, 2)}
                        </pre>
                      )}
                      {result.screenshots && result.screenshots.length > 0 && (
                        <div className="flex gap-2 flex-wrap">
                          {result.screenshots.map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="border border-border rounded">
                              <img src={url} alt={`Screenshot ${i + 1}`} className="w-48 h-auto" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PanelPage>
  )
}
