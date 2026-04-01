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
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg">Projects</h1>
        <Link href="/projects/new" className="text-sm underline">
          + New
        </Link>
      </div>

      {(!projects || projects.length === 0) ? (
        <p className="text-sm opacity-40 py-8">
          No projects yet.{' '}
          <Link href="/projects/new" className="underline">Create one</Link> to get started.
        </p>
      ) : (
        <div className="divide-y">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="flex items-center justify-between py-3 group"
            >
              <div>
                <p className="text-sm">{project.name}</p>
                <p className="text-xs opacity-40">{project.app_url}</p>
              </div>
              <span className="text-xs opacity-30 group-hover:opacity-60">→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
