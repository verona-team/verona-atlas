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
    <div className="max-w-4xl mx-auto space-y-10">
      <div>
        <Link href={`/projects/${projectId}`} className="text-xl opacity-50 hover:opacity-80">
          ← {project.name}
        </Link>
        <div className="flex items-center justify-between mt-3">
          <h1 className="text-5xl">Runs</h1>
          <TriggerRunButton projectId={projectId} />
        </div>
      </div>

      {(!runs || runs.length === 0) ? (
        <p className="text-2xl opacity-50 py-8">No runs yet.</p>
      ) : (
        <div className="divide-y text-2xl">
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
                className="flex items-center justify-between py-4"
              >
                <div className="flex items-center gap-6">
                  <RunStatusBadge status={run.status} />
                  <span className="text-xl opacity-50">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                  <span className="text-xl opacity-40">{duration}</span>
                </div>
                {summary && summary.total > 0 ? (
                  <span className="text-xl opacity-60">
                    {summary.passed}/{summary.total}
                  </span>
                ) : (
                  <span className="text-xl opacity-30">—</span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
