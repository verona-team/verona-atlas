import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
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

  const { data: integrations } = await supabase
    .from('integrations')
    .select('type, status')
    .eq('project_id', projectId)

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-2">
        <Link
          href={`/projects/${project.id}`}
          className="text-[10px] text-[#6b6555] hover:text-[#1a1a1a] uppercase tracking-wider transition-colors"
        >
          ← Back to {project.name}
        </Link>
      </div>

      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Configuration — {project.name}
        </div>
        <div className="window-body space-y-4">
          <div>
            <p className="text-xs text-[#6b6555] uppercase tracking-wider mb-2">Integrations</p>
            {integrations && integrations.length > 0 ? (
              <div className="border-2 border-[#1a1a1a] divide-y divide-[#b8b3a4] text-sm">
                {integrations.map((row) => (
                  <div key={row.type} className="flex justify-between px-3 py-2">
                    <span className="uppercase text-xs tracking-wider text-[#1a1a1a]">{row.type}</span>
                    <span className="text-[#6b6555] text-xs uppercase tracking-wider">{row.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[#6b6555]">No integrations connected.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
