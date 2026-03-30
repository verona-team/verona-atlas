'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Clock,
  Image as ImageIcon,
} from 'lucide-react'
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

const statusIcons: Record<string, React.ReactNode> = {
  passed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  error: <AlertTriangle className="h-4 w-4 text-orange-500" />,
  skipped: <SkipForward className="h-4 w-4 text-gray-400" />,
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

  // Real-time status updates via Supabase Realtime
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
          // Refetch results when run completes
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
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!run) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Run not found</p>
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/projects/${projectId}/runs`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Test Run Detail</h1>
          <p className="text-sm text-muted-foreground">{projectName}</p>
        </div>
      </div>

      {/* Run Metadata */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-4">
            <RunStatusBadge status={run.status} />
            <span className="text-sm text-muted-foreground font-mono">
              {run.id.slice(0, 8)}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Trigger</p>
              <p className="font-medium capitalize">{run.trigger}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Started</p>
              <p className="font-medium">
                {run.started_at
                  ? new Date(run.started_at).toLocaleString()
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Duration</p>
              <p className="font-medium">{duration}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Completed</p>
              <p className="font-medium">
                {run.completed_at
                  ? new Date(run.completed_at).toLocaleString()
                  : '—'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Stats */}
      {summary && typeof summary.total === 'number' && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-2xl font-bold">{Number(summary.total)}</p>
              <p className="text-sm text-muted-foreground">Total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-2xl font-bold text-green-600">{Number(summary.passed || 0)}</p>
              <p className="text-sm text-muted-foreground">Passed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-2xl font-bold text-red-600">{Number(summary.failed || 0)}</p>
              <p className="text-sm text-muted-foreground">Failed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-2xl font-bold text-orange-600">{Number(summary.errors || 0)}</p>
              <p className="text-sm text-muted-foreground">Errors</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* AI Analysis */}
      {summary?.ai_analysis && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">AI Analysis</CardTitle>
            <CardDescription>Automated analysis of the test run results</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap">
              {String(summary.ai_analysis)}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Test Results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Test Results</CardTitle>
          <CardDescription>
            {results.length} test{results.length !== 1 ? 's' : ''} executed
          </CardDescription>
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <Clock className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                {run.status === 'pending' || run.status === 'planning' || run.status === 'running'
                  ? 'Tests are still executing...'
                  : 'No test results available'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {results.map((result) => (
                <div key={result.id} className="rounded-md border">
                  <button
                    className="flex items-center justify-between w-full p-4 text-left hover:bg-accent transition-colors"
                    onClick={() =>
                      setExpandedResult(
                        expandedResult === result.id ? null : result.id
                      )
                    }
                  >
                    <div className="flex items-center gap-3">
                      {statusIcons[result.status] || statusIcons.error}
                      <div>
                        <p className="text-sm font-medium">
                          {result.test_templates?.name || 'Unknown Template'}
                        </p>
                        {result.error_message && (
                          <p className="text-xs text-red-500 truncate max-w-md">
                            {result.error_message}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {result.duration_ms && (
                        <span className="text-xs text-muted-foreground">
                          {(result.duration_ms / 1000).toFixed(1)}s
                        </span>
                      )}
                      <Badge
                        variant={result.status === 'passed' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {result.status}
                      </Badge>
                    </div>
                  </button>

                  {expandedResult === result.id && (
                    <div className="border-t p-4 space-y-4 bg-muted/30">
                      {/* Error Details */}
                      {result.error_message && (
                        <div>
                          <h4 className="text-sm font-medium text-red-600 mb-1">Error</h4>
                          <pre className="text-xs bg-red-50 dark:bg-red-950 rounded p-3 overflow-x-auto whitespace-pre-wrap">
                            {result.error_message}
                          </pre>
                        </div>
                      )}

                      {/* AI Analysis */}
                      {result.ai_analysis && (
                        <div>
                          <h4 className="text-sm font-medium mb-1">AI Analysis</h4>
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                            {result.ai_analysis}
                          </p>
                        </div>
                      )}

                      {/* Console Logs */}
                      {result.console_logs && (
                        <div>
                          <h4 className="text-sm font-medium mb-1">Console Logs</h4>
                          <pre className="text-xs bg-muted rounded p-3 overflow-x-auto max-h-48">
                            {JSON.stringify(result.console_logs, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* Screenshots */}
                      {result.screenshots && result.screenshots.length > 0 && (
                        <div>
                          <h4 className="text-sm font-medium mb-1">
                            <ImageIcon className="inline h-4 w-4 mr-1" />
                            Screenshots
                          </h4>
                          <div className="grid grid-cols-2 gap-2">
                            {result.screenshots.map((url, i) => (
                              <a
                                key={i}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded border overflow-hidden hover:opacity-80 transition"
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
        </CardContent>
      </Card>
    </div>
  )
}
