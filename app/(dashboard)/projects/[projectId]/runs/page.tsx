import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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
    <div className="max-w-3xl mx-auto">
      <div className="mb-2">
        <Link
          href={`/projects/${projectId}`}
          className="text-[10px] text-phosphor-dim hover:text-foreground uppercase tracking-wider transition-colors"
        >
          ← Back to {project.name}
        </Link>
      </div>

      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Run History — {project.name}
        </div>
        <div className="window-body space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-phosphor-dim uppercase tracking-wider">
              {runs?.length ?? 0} runs
            </span>
            <TriggerRunButton projectId={projectId} />
          </div>

          {(!runs || runs.length === 0) ? (
            <div className="border border-dashed border-border py-8 text-center">
              <p className="text-xs text-phosphor-dim uppercase">
                No runs found. Trigger a test run to begin.
              </p>
            </div>
          ) : (
            <div className="border border-border">
              {/* Header */}
              <div className="grid grid-cols-5 gap-px bg-border text-[10px] uppercase tracking-wider text-phosphor-dim">
                <div className="bg-card px-3 py-1.5">Status</div>
                <div className="bg-card px-3 py-1.5">Trigger</div>
                <div className="bg-card px-3 py-1.5">Started</div>
                <div className="bg-card px-3 py-1.5">Duration</div>
                <div className="bg-card px-3 py-1.5 text-right">Results</div>
              </div>
              {/* Rows */}
              <div className="divide-y divide-border">
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
                    <Link
                      key={run.id}
                      href={`/projects/${projectId}/runs/${run.id}`}
                      className="grid grid-cols-5 text-xs hover:bg-accent transition-colors"
                    >
                      <div className="px-3 py-2">
                        <RunStatusBadge status={run.status} />
                      </div>
                      <div className="px-3 py-2 uppercase">{run.trigger}</div>
                      <div className="px-3 py-2 text-phosphor-dim">
                        {new Date(run.created_at).toLocaleString()}
                      </div>
                      <div className="px-3 py-2">{duration}</div>
                      <div className="px-3 py-2 text-right">
                        {summary && summary.total > 0 ? (
                          <span>
                            <span className="text-[#33ff33]">{summary.passed}</span>
                            {' / '}
                            <span className="text-destructive">
                              {(summary.failed || 0) + (summary.errors || 0)}
                            </span>
                            {' / '}
                            {summary.total}
                          </span>
                        ) : (
                          <span className="text-phosphor-dim">—</span>
                        )}
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
