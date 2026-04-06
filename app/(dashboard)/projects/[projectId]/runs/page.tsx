import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { RunStatusBadge } from '@/components/dashboard/run-status-badge'
import { PanelPage } from '@/components/dashboard/panel-page'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function RunHistoryPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()

  const user = await getServerUser(supabase)
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
    <PanelPage projectId={projectId} title="Runs">
      {(!runs || runs.length === 0) ? (
        <p className="text-sm text-muted-foreground py-8">No runs yet.</p>
      ) : (
        <div className="divide-y divide-border">
          {runs.map((run) => {
            const summary = run.summary as Record<string, number> | null
            const duration =
              run.started_at && run.completed_at
                ? `${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
                : '—'

            return (
              <Link
                key={run.id}
                href={`/projects/${projectId}/runs/${run.id}`}
                className="flex items-center justify-between py-3 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors"
              >
                <div className="flex items-center gap-4">
                  <RunStatusBadge status={run.status} />
                  <span className="text-xs text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground/60">{duration}</span>
                </div>
                {summary && summary.total > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {summary.passed}/{summary.total}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground/30">—</span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </PanelPage>
  )
}
