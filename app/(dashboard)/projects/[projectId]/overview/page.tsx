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

  const { data: recentRuns } = await supabase
    .from('test_runs')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(5)

  const { count: templateCount } = await supabase
    .from('test_templates')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('is_active', true)

  return (
    <div className="max-w-4xl mx-auto space-y-14">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-4xl">{project.name}</h1>
          <p className="text-lg opacity-50 mt-2">{project.app_url}</p>
        </div>
        <TriggerRunButton projectId={project.id} />
      </div>

      <div className="flex gap-16 text-xl">
        <div>
          <span className="opacity-50">Runs</span>{' '}
          {recentRuns?.length || 0}
        </div>
        <div>
          <span className="opacity-50">Templates</span>{' '}
          {templateCount || 0}
        </div>
      </div>

      <nav className="space-y-3 text-xl">
        <Link href={`/projects/${project.id}/chat`} className="block py-2 underline">
          Chat
        </Link>
        <Link href={`/projects/${project.id}/templates`} className="block py-2 underline">
          Templates
        </Link>
        <Link href={`/projects/${project.id}/runs`} className="block py-2 underline">
          Run History
        </Link>
        <Link href={`/projects/${project.id}/settings`} className="block py-2 underline">
          Settings
        </Link>
      </nav>

      {recentRuns && recentRuns.length > 0 && (
        <div>
          <h2 className="text-xl mb-4 opacity-50">Recent Runs</h2>
          <div className="divide-y text-xl">
            {recentRuns.map((run) => {
              const summary = run.summary as Record<string, number> | null
              return (
                <Link
                  key={run.id}
                  href={`/projects/${project.id}/runs/${run.id}`}
                  className="flex items-center justify-between py-4"
                >
                  <div className="flex items-center gap-6">
                    <RunStatusBadge status={run.status} />
                    <span className="text-lg opacity-50">
                      {new Date(run.created_at).toLocaleString()}
                    </span>
                  </div>
                  {summary && summary.total > 0 && (
                    <span className="text-lg opacity-60">
                      {summary.passed}/{summary.total}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
