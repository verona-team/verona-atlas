import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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

  const { data: integrations } = await supabase
    .from('integrations')
    .select('type, status')
    .eq('project_id', projectId)

  const { data: recentRuns } = await supabase
    .from('test_runs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(10)

  const { count: templateCount } = await supabase
    .from('test_templates')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('is_active', true)

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
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          {project.name}
        </div>
        <div className="window-body space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-[#6b6555] uppercase tracking-wider">URL</p>
              <p className="text-sm break-all text-[#1a1a1a]">{project.app_url}</p>
            </div>
            <div className="flex gap-2">
              <TriggerRunButton projectId={project.id} />
              <Link
                href={`/projects/${project.id}/settings`}
                className="text-xs uppercase tracking-wider border-2 border-[#1a1a1a] px-3 py-1.5 hover:bg-[#1a1a1a] hover:text-[#fffef9] transition-colors inline-flex items-center"
              >
                Config
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-4 border-2 border-[#1a1a1a]">
            <div className="border-r-2 border-[#1a1a1a] p-3 text-center">
              <p className="text-lg font-bold text-[#1a1a1a]">{recentRuns?.length || 0}</p>
              <p className="text-[10px] text-[#6b6555] uppercase tracking-wider">Runs</p>
            </div>
            <div className="border-r-2 border-[#1a1a1a] p-3 text-center">
              <p className="text-lg font-bold text-[#1a1a1a]">{passRate}%</p>
              <p className="text-[10px] text-[#6b6555] uppercase tracking-wider">Pass Rate</p>
            </div>
            <div className="border-r-2 border-[#1a1a1a] p-3 text-center">
              <p className="text-lg font-bold text-[#1a1a1a]">{templateCount || 0}</p>
              <p className="text-[10px] text-[#6b6555] uppercase tracking-wider">Templates</p>
            </div>
            <div className="p-3 text-center">
              <p className="text-sm font-bold text-[#1a1a1a]">
                {recentRuns && recentRuns.length > 0
                  ? new Date(recentRuns[0].created_at).toLocaleDateString()
                  : '—'}
              </p>
              <p className="text-[10px] text-[#6b6555] uppercase tracking-wider">Last Run</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-[#6b6555] uppercase tracking-wider mb-2">Integrations</p>
            <div className="flex gap-2">
              {(['github', 'posthog', 'slack'] as const).map((type) => {
                const status = integrationMap.get(type)
                return (
                  <span
                    key={type}
                    className="text-[10px] uppercase tracking-wider border border-[#b8b3a4] px-2 py-0.5 text-[#1a1a1a]"
                  >
                    {status === 'active' ? '■' : '□'} {type}
                  </span>
                )
              })}
            </div>
          </div>

          <div className="border-2 border-[#1a1a1a] divide-y-2 divide-[#1a1a1a]">
            <Link
              href={`/projects/${project.id}/templates`}
              className="flex items-center justify-between px-3 py-2 hover:bg-[#e8e4d9] transition-colors"
            >
              <span className="text-xs uppercase tracking-wider text-[#1a1a1a]">▸ Test Templates</span>
              <span className="text-[#b8b3a4]">→</span>
            </Link>
            <Link
              href={`/projects/${project.id}/runs`}
              className="flex items-center justify-between px-3 py-2 hover:bg-[#e8e4d9] transition-colors"
            >
              <span className="text-xs uppercase tracking-wider text-[#1a1a1a]">▸ Run History</span>
              <span className="text-[#b8b3a4]">→</span>
            </Link>
            <Link
              href={`/projects/${project.id}/settings`}
              className="flex items-center justify-between px-3 py-2 hover:bg-[#e8e4d9] transition-colors"
            >
              <span className="text-xs uppercase tracking-wider text-[#1a1a1a]">▸ Configuration</span>
              <span className="text-[#b8b3a4]">→</span>
            </Link>
          </div>
        </div>
      </div>

      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Recent Runs
        </div>
        <div className="window-body">
          {(!recentRuns || recentRuns.length === 0) ? (
            <div className="py-6 text-center">
              <p className="text-xs text-[#6b6555] uppercase">
                No test runs yet. Trigger a run to begin.
              </p>
            </div>
          ) : (
            <div className="border-2 border-[#1a1a1a] divide-y divide-[#b8b3a4]">
              {recentRuns.slice(0, 5).map((run) => {
                const summary = run.summary as Record<string, number> | null
                return (
                  <Link
                    key={run.id}
                    href={`/projects/${project.id}/runs/${run.id}`}
                    className="flex items-center justify-between px-3 py-2 hover:bg-[#e8e4d9] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <RunStatusBadge status={run.status} />
                      <div>
                        <p className="text-xs uppercase tracking-wider text-[#1a1a1a]">
                          {run.trigger === 'manual' ? 'Manual Run' : run.trigger}
                        </p>
                        <p className="text-[10px] text-[#6b6555]">
                          {new Date(run.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    {summary && summary.total > 0 && (
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
                        <span className="text-[#2a7a2a]">{summary.passed} OK</span>
                        {(summary.failed > 0 || summary.errors > 0) && (
                          <span className="text-[#c43333]">
                            {(summary.failed || 0) + (summary.errors || 0)} FAIL
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
          {recentRuns && recentRuns.length > 0 && (
            <div className="mt-2 text-right">
              <Link
                href={`/projects/${project.id}/runs`}
                className="text-[10px] text-[#6b6555] hover:text-[#1a1a1a] uppercase tracking-wider transition-colors"
              >
                View all runs →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
