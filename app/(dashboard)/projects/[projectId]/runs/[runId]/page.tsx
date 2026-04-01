'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { RunStatusBadge } from '@/components/dashboard/run-status-badge'
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
  const [projectName, setProjectName] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedResult, setExpandedResult] = useState<string | null>(null)

  const fetchRunData = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${runId}`)
      if (response.ok) {
        const data = await response.json()
        setRun(data.run)
        setResults(data.results)
        setProjectName(data.project?.name || '')
      }
    } catch { /* ignore */ } finally { setLoading(false) }
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

  if (loading) return <p className="text-base opacity-30 py-8">Loading...</p>
  if (!run) return <p className="text-base opacity-30 py-8">Run not found</p>

  const summary = run.summary as { total?: number; passed?: number; failed?: number; errors?: number; ai_analysis?: string; [key: string]: unknown } | null
  const duration = run.started_at && run.completed_at
    ? `${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
    : run.started_at ? 'Running...' : '—'

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <Link href={`/projects/${projectId}/runs`} className="text-sm opacity-40 hover:opacity-70">
          ← Runs
        </Link>
        <div className="flex items-center gap-3 mt-2">
          <h1 className="text-2xl">{projectName}</h1>
          <RunStatusBadge status={run.status} />
        </div>
      </div>

      <div className="flex gap-10 text-base">
        <div><span className="opacity-40">Trigger</span> {run.trigger}</div>
        <div><span className="opacity-40">Duration</span> {duration}</div>
        <div><span className="opacity-40">ID</span> {run.id.slice(0, 8)}</div>
      </div>

      {summary && typeof summary.total === 'number' && (
        <div className="flex gap-10 text-base">
          <div>{summary.total} total</div>
          <div className="text-green-700">{summary.passed || 0} passed</div>
          <div className="text-red-700">{summary.failed || 0} failed</div>
          <div className="text-amber-700">{summary.errors || 0} errors</div>
        </div>
      )}

      {summary?.ai_analysis && (
        <div>
          <h2 className="text-base opacity-40 mb-2">AI Analysis</h2>
          <pre className="text-sm whitespace-pre-wrap opacity-60">{String(summary.ai_analysis)}</pre>
        </div>
      )}

      <div>
        <h2 className="text-base opacity-40 mb-3">Results ({results.length})</h2>
        {results.length === 0 ? (
          <p className="text-base opacity-30">
            {['pending', 'planning', 'running'].includes(run.status) ? 'Running...' : 'No results'}
          </p>
        ) : (
          <div className="divide-y text-base">
            {results.map((result) => (
              <div key={result.id}>
                <button
                  className="flex items-center justify-between w-full py-3 text-left"
                  onClick={() => setExpandedResult(expandedResult === result.id ? null : result.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className={result.status === 'passed' ? 'text-green-700' : result.status === 'failed' ? 'text-red-700' : 'text-amber-700'}>
                      {result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '!'}
                    </span>
                    <span>{result.test_templates?.name || 'Unknown'}</span>
                  </div>
                  <span className="text-sm opacity-30">
                    {result.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : ''}
                  </span>
                </button>

                {expandedResult === result.id && (
                  <div className="pb-4 pl-6 space-y-3 text-sm">
                    {result.error_message && (
                      <pre className="whitespace-pre-wrap text-red-700">{result.error_message}</pre>
                    )}
                    {result.ai_analysis && (
                      <pre className="whitespace-pre-wrap opacity-50">{result.ai_analysis}</pre>
                    )}
                    {result.console_logs && (
                      <pre className="whitespace-pre-wrap opacity-40 max-h-48 overflow-auto">
                        {JSON.stringify(result.console_logs, null, 2)}
                      </pre>
                    )}
                    {result.screenshots && result.screenshots.length > 0 && (
                      <div className="flex gap-2">
                        {result.screenshots.map((url, i) => (
                          <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="border">
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
  )
}
