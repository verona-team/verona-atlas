import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Settings, Play, FileText, BarChart3, CheckCircle2, XCircle, Clock, AlertCircle } from 'lucide-react'
import { TriggerRunButton } from '@/components/dashboard/trigger-run-button'
import { RunStatusBadge } from '@/components/dashboard/run-status-badge'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectOverviewPage({ params }: PageProps) {
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
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) notFound()

  // Fetch integrations
  const { data: integrations } = await supabase
    .from('integrations')
    .select('type, status')
    .eq('project_id', projectId)

  // Fetch recent runs
  const { data: recentRuns } = await supabase
    .from('test_runs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(10)

  // Fetch template count
  const { count: templateCount } = await supabase
    .from('test_templates')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('is_active', true)

  // Calculate stats
  const completedRuns = recentRuns?.filter((r) => r.status === 'completed') || []
  const totalTests = completedRuns.reduce(
    (sum, r) => sum + ((r.summary as Record<string, number>)?.total || 0),
    0
  )
  const totalPassed = completedRuns.reduce(
    (sum, r) => sum + ((r.summary as Record<string, number>)?.passed || 0),
    0
  )
  const passRate = totalTests > 0 ? Math.round((totalPassed / totalTests) * 100) : 0

  const integrationMap = new Map(
    integrations?.map((i) => [i.type, i.status]) || []
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{project.name}</h1>
          <p className="text-muted-foreground break-all">{project.app_url}</p>
        </div>
        <div className="flex items-center gap-2">
          <TriggerRunButton projectId={project.id} />
          <Link href={`/projects/${project.id}/settings`}>
            <Button variant="outline">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Total Runs</p>
            </div>
            <p className="text-2xl font-bold mt-1">{recentRuns?.length || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <p className="text-sm text-muted-foreground">Pass Rate</p>
            </div>
            <p className="text-2xl font-bold mt-1">{passRate}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Active Templates</p>
            </div>
            <p className="text-2xl font-bold mt-1">{templateCount || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Last Run</p>
            </div>
            <p className="text-sm font-medium mt-1">
              {recentRuns && recentRuns.length > 0
                ? new Date(recentRuns[0].created_at).toLocaleDateString()
                : 'Never'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Integrations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Integrations</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {(['github', 'posthog', 'slack'] as const).map((type) => {
              const status = integrationMap.get(type)
              return (
                <Badge
                  key={type}
                  variant={status === 'active' ? 'default' : 'secondary'}
                  className="capitalize"
                >
                  {status === 'active' ? '✓' : '✗'} {type}
                </Badge>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Quick Links */}
      <div className="grid gap-4 md:grid-cols-3">
        <Link href={`/projects/${project.id}/templates`}>
          <Card className="hover:border-primary/50 transition-colors cursor-pointer">
            <CardContent className="pt-6 flex items-center gap-3">
              <FileText className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Test Templates</p>
                <p className="text-sm text-muted-foreground">
                  Manage test flows
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/projects/${project.id}/runs`}>
          <Card className="hover:border-primary/50 transition-colors cursor-pointer">
            <CardContent className="pt-6 flex items-center gap-3">
              <BarChart3 className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Run History</p>
                <p className="text-sm text-muted-foreground">
                  View past test runs
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href={`/projects/${project.id}/settings`}>
          <Card className="hover:border-primary/50 transition-colors cursor-pointer">
            <CardContent className="pt-6 flex items-center gap-3">
              <Settings className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Settings</p>
                <p className="text-sm text-muted-foreground">
                  Configure integrations
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Recent Runs */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Recent Runs</CardTitle>
            <Link href={`/projects/${project.id}/runs`}>
              <Button variant="ghost" size="sm">View All</Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {(!recentRuns || recentRuns.length === 0) ? (
            <div className="flex flex-col items-center py-8 text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No test runs yet. Click &quot;Run Tests&quot; to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recentRuns.slice(0, 5).map((run) => {
                const summary = run.summary as Record<string, number> | null
                return (
                  <Link
                    key={run.id}
                    href={`/projects/${project.id}/runs/${run.id}`}
                    className="flex items-center justify-between rounded-md border p-3 hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <RunStatusBadge status={run.status} />
                      <div>
                        <p className="text-sm font-medium">
                          {run.trigger === 'manual' ? 'Manual Run' : run.trigger}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(run.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {summary && summary.total > 0 && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-green-600">{summary.passed} passed</span>
                        {(summary.failed > 0 || summary.errors > 0) && (
                          <span className="text-red-600">
                            {(summary.failed || 0) + (summary.errors || 0)} failed
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
