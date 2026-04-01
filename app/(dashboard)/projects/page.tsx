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
            <span className="text-xs text-[#6b6555] uppercase tracking-wider">
              {projects?.length ?? 0} project{(projects?.length ?? 0) !== 1 ? 's' : ''} registered
            </span>
            <Link
              href="/projects/new"
              className="text-xs uppercase tracking-wider border-2 border-[#1a1a1a] px-3 py-1 hover:bg-[#1a1a1a] hover:text-[#fffef9] transition-colors"
            >
              + New Project
            </Link>
          </div>

          {(!projects || projects.length === 0) ? (
            <div className="border-2 border-dashed border-[#b8b3a4] py-12 text-center">
              <p className="text-sm text-[#6b6555] mb-1">NO PROJECTS FOUND</p>
              <p className="text-xs text-[#6b6555]">
                Create your first project to begin autonomous QA testing.
              </p>
              <Link
                href="/projects/new"
                className="inline-block mt-4 text-xs uppercase tracking-wider border-2 border-[#1a1a1a] px-3 py-1 hover:bg-[#1a1a1a] hover:text-[#fffef9] transition-colors"
              >
                + Create Project
              </Link>
            </div>
          ) : (
            <div className="border-2 border-[#1a1a1a] divide-y-2 divide-[#1a1a1a]">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="block px-3 py-3 hover:bg-[#e8e4d9] transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-[#6b6555] text-xs">▸</span>
                      <div>
                        <p className="text-sm font-bold uppercase tracking-wide text-[#1a1a1a]">
                          {project.name}
                        </p>
                        <p className="text-xs text-[#6b6555] truncate max-w-md">
                          {project.app_url}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-[#6b6555] border border-[#b8b3a4] px-2 py-0.5">
                        {project.agentmail_inbox_address ? 'INBOX OK' : 'NO INBOX'}
                      </span>
                      <span className="text-[#b8b3a4] group-hover:text-[#1a1a1a] transition-colors">→</span>
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
