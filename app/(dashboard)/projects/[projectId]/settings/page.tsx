import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectSettingsPage({ params }: PageProps) {
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

  const { data: integrations } = await supabase
    .from('integrations')
    .select('type, status')
    .eq('project_id', projectId)

  return (
    <div className="max-w-lg space-y-8">
      <div>
        <Link href={`/projects/${project.id}`} className="text-sm opacity-40 hover:opacity-70">
          ← {project.name}
        </Link>
        <h1 className="text-2xl mt-2">Settings</h1>
      </div>

      <div>
        <h2 className="text-base opacity-40 mb-3">Integrations</h2>
        {integrations && integrations.length > 0 ? (
          <div className="divide-y text-base">
            {integrations.map((row) => (
              <div key={row.type} className="flex justify-between py-3">
                <span>{row.type}</span>
                <span className="opacity-40">{row.status}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-base opacity-30">No integrations connected.</p>
        )}
      </div>
    </div>
  )
}
