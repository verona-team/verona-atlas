import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export default async function ProjectsPage() {
  const supabase = await createClient()

  const { data: userData } = await supabase.auth.getUser()
  if (!userData.user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userData.user.id)
    .limit(1)
    .single()

  const orgId = membership?.org_id

  const { data: projects } = orgId
    ? await supabase
        .from('projects')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
    : { data: [] as never[] }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Projects
        </div>
        <div className="window-body space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-phosphor-dim uppercase tracking-wider">
              {projects?.length ?? 0} project{(projects?.length ?? 0) !== 1 ? 's' : ''} registered
            </span>
            <Link
              href="/projects/new"
              className="text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors"
            >
              + New Project
            </Link>
          </div>

          {(!projects || projects.length === 0) ? (
            <div className="border border-dashed border-border py-12 text-center">
              <p className="text-sm text-phosphor-dim mb-1">NO PROJECTS FOUND</p>
              <p className="text-xs text-phosphor-dim">
                Create your first project to begin autonomous QA testing.
              </p>
              <Link
                href="/projects/new"
                className="inline-block mt-4 text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors"
              >
                + Create Project
              </Link>
            </div>
          ) : (
            <div className="border border-border divide-y divide-border">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="block px-3 py-3 hover:bg-accent transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-phosphor-dim text-xs">▸</span>
                      <div>
                        <p className="text-sm font-bold uppercase tracking-wide">
                          {project.name}
                        </p>
                        <p className="text-xs text-phosphor-dim truncate max-w-md">
                          {project.app_url}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-phosphor-dim border border-border px-2 py-0.5">
                        {project.agentmail_inbox_address ? 'INBOX OK' : 'NO INBOX'}
                      </span>
                      <span className="text-phosphor-dim group-hover:text-foreground transition-colors">→</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
