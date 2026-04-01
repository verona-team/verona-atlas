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
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    fetchRunData()
  }, [fetchRunData])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`test-run-${runId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'test_runs',
          filter: `id=eq.${runId}`,
        },
        (payload) => {
          setRun(payload.new as TestRun)
          if (['completed', 'failed'].includes((payload.new as TestRun).status)) {
            fetchRunData()
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'test_results',
          filter: `test_run_id=eq.${runId}`,
        },
        () => {
          fetchRunData()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [runId, fetchRunData])

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <p className="text-xs text-phosphor-dim uppercase tracking-wider animate-pulse">
          Loading...
        </p>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <p className="text-xs text-phosphor-dim uppercase">Run not found</p>
      </div>
    )
  }

  const summary = run.summary as { total?: number; passed?: number; failed?: number; errors?: number; skipped?: number; ai_analysis?: string; [key: string]: unknown } | null
  const duration =
    run.started_at && run.completed_at
      ? `${Math.round(
          (new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000
        )}s`
      : run.started_at
        ? 'In progress...'
        : 'Not started'

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="mb-2">
        <Link
          href={`/projects/${projectId}/runs`}
          className="text-[10px] text-phosphor-dim hover:text-foreground uppercase tracking-wider transition-colors"
        >
          ← Back to runs
        </Link>
      </div>

      {/* Run Info Window */}
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Run Detail — {projectName}
        </div>
        <div className="window-body space-y-4">
          <div className="flex items-center justify-between">
            <RunStatusBadge status={run.status} />
            <span className="text-[10px] text-phosphor-dim">{run.id.slice(0, 8)}</span>
          </div>

          <div className="grid grid-cols-4 gap-px border border-border bg-border text-xs">
            <div className="bg-card px-3 py-2">
              <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Trigger</p>
              <p className="uppercase">{run.trigger}</p>
            </div>
            <div className="bg-card px-3 py-2">
              <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Started</p>
              <p>{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</p>
            </div>
            <div className="bg-card px-3 py-2">
              <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Duration</p>
              <p>{duration}</p>
            </div>
            <div className="bg-card px-3 py-2">
              <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Completed</p>
              <p>{run.completed_at ? new Date(run.completed_at).toLocaleString() : '—'}</p>
            </div>
          </div>

          {/* Summary Stats */}
          {summary && typeof summary.total === 'number' && (
            <div className="grid grid-cols-4 gap-px border border-border bg-border">
              <div className="bg-card px-3 py-2 text-center">
                <p className="text-lg font-bold">{Number(summary.total)}</p>
                <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Total</p>
              </div>
              <div className="bg-card px-3 py-2 text-center">
                <p className="text-lg font-bold text-[#33ff33]">{Number(summary.passed || 0)}</p>
                <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Passed</p>
              </div>
              <div className="bg-card px-3 py-2 text-center">
                <p className="text-lg font-bold text-destructive">{Number(summary.failed || 0)}</p>
                <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Failed</p>
              </div>
              <div className="bg-card px-3 py-2 text-center">
                <p className="text-lg font-bold text-[#ff8800]">{Number(summary.errors || 0)}</p>
                <p className="text-[10px] text-phosphor-dim uppercase tracking-wider">Errors</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* AI Analysis */}
      {summary?.ai_analysis && (
        <div className="window-chrome">
          <div className="window-title-bar">
            <span className="close-box" />
            AI Analysis
          </div>
          <div className="window-body">
            <pre className="text-xs whitespace-pre-wrap text-phosphor-dim">
              {String(summary.ai_analysis)}
            </pre>
          </div>
        </div>
      )}

      {/* Test Results Window */}
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Test Results ({results.length})
        </div>
        <div className="window-body">
          {results.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-xs text-phosphor-dim uppercase">
                {run.status === 'pending' || run.status === 'planning' || run.status === 'running'
                  ? 'Tests are executing...'
                  : 'No test results available'}
              </p>
            </div>
          ) : (
            <div className="border border-border divide-y divide-border">
              {results.map((result) => (
                <div key={result.id}>
                  <button
                    className="flex items-center justify-between w-full px-3 py-2 text-left hover:bg-accent transition-colors"
                    onClick={() =>
                      setExpandedResult(
                        expandedResult === result.id ? null : result.id
                      )
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className={
                        result.status === 'passed' ? 'text-[#33ff33]' :
                        result.status === 'failed' ? 'text-destructive' :
                        'text-[#ff8800]'
                      }>
                        {result.status === 'passed' ? '■' : result.status === 'failed' ? '✗' : '▲'}
                      </span>
                      <span className="text-xs uppercase tracking-wider">
                        {result.test_templates?.name || 'Unknown'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {result.duration_ms && (
                        <span className="text-[10px] text-phosphor-dim">
                          {(result.duration_ms / 1000).toFixed(1)}s
                        </span>
                      )}
                      <span className="text-[10px] uppercase tracking-wider border border-border px-2 py-0.5">
                        {result.status}
                      </span>
                    </div>
                  </button>

                  {expandedResult === result.id && (
                    <div className="border-t border-border px-3 py-3 bg-[#0e0e0e] space-y-3">
                      {result.error_message && (
                        <div>
                          <p className="text-[10px] text-destructive uppercase tracking-wider mb-1">Error</p>
                          <pre className="text-xs text-destructive/80 whitespace-pre-wrap border border-destructive/30 p-2 bg-destructive/5">
                            {result.error_message}
                          </pre>
                        </div>
                      )}

                      {result.ai_analysis && (
                        <div>
                          <p className="text-[10px] text-phosphor-dim uppercase tracking-wider mb-1">Analysis</p>
                          <pre className="text-xs text-phosphor-dim whitespace-pre-wrap">
                            {result.ai_analysis}
                          </pre>
                        </div>
                      )}

                      {result.console_logs && (
                        <div>
                          <p className="text-[10px] text-phosphor-dim uppercase tracking-wider mb-1">Console</p>
                          <pre className="text-xs text-phosphor-dim whitespace-pre-wrap border border-border p-2 max-h-48 overflow-auto">
                            {JSON.stringify(result.console_logs, null, 2)}
                          </pre>
                        </div>
                      )}

                      {result.screenshots && result.screenshots.length > 0 && (
                        <div>
                          <p className="text-[10px] text-phosphor-dim uppercase tracking-wider mb-1">Screenshots</p>
                          <div className="grid grid-cols-2 gap-2">
                            {result.screenshots.map((url, i) => (
                              <a
                                key={i}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="border border-border overflow-hidden hover:border-foreground transition-colors"
                              >
                                <img
                                  src={url}
                                  alt={`Screenshot ${i + 1}`}
                                  className="w-full h-auto"
                                />
                              </a>
                            ))}
                          </div>
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
    </div>
  )
}
