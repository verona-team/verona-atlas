import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ArrowLeft, Clock } from 'lucide-react'
import { RunStatusBadge } from '@/components/dashboard/run-status-badge'
import { TriggerRunButton } from '@/components/dashboard/trigger-run-button'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function RunHistoryPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) notFound()

  const { data: runs } = await supabase
    .from('test_runs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(50)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/projects/${projectId}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Run History</h1>
            <p className="text-sm text-muted-foreground">{project.name}</p>
          </div>
        </div>
        <TriggerRunButton projectId={projectId} />
      </div>

      <Card>
        <CardContent className="p-0">
          {(!runs || runs.length === 0) ? (
            <div className="flex flex-col items-center py-12 text-center">
              <Clock className="h-10 w-10 text-muted-foreground mb-3" />
              <h3 className="text-lg font-semibold mb-1">No runs yet</h3>
              <p className="text-sm text-muted-foreground">
                Trigger your first test run to see results here.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const summary = run.summary as Record<string, number> | null
                  const duration =
                    run.started_at && run.completed_at
                      ? `${Math.round(
                          (new Date(run.completed_at).getTime() -
                            new Date(run.started_at).getTime()) /
                            1000
                        )}s`
                      : '—'

                  return (
                    <TableRow key={run.id} className="cursor-pointer">
                      <TableCell>
                        <Link href={`/projects/${projectId}/runs/${run.id}`}>
                          <RunStatusBadge status={run.status} />
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/projects/${projectId}/runs/${run.id}`} className="capitalize text-sm">
                          {run.trigger}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/projects/${projectId}/runs/${run.id}`} className="text-sm text-muted-foreground">
                          {new Date(run.created_at).toLocaleString()}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link href={`/projects/${projectId}/runs/${run.id}`} className="text-sm">
                          {duration}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link href={`/projects/${projectId}/runs/${run.id}`}>
                          {summary && summary.total > 0 ? (
                            <span className="text-sm">
                              <span className="text-green-600">{summary.passed}</span>
                              {' / '}
                              <span className="text-red-600">
                                {(summary.failed || 0) + (summary.errors || 0)}
                              </span>
                              {' / '}
                              {summary.total}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
