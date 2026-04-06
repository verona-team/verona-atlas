import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { SignOutLink } from '@/components/dashboard/sign-out-link'

export default async function ProjectsPage() {
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
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
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4 mb-12">
        <h1 className="text-5xl">Projects</h1>
        <div className="flex shrink-0 items-center gap-6">
          <SignOutLink className="text-xl text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" />
          <Link href="/projects/new" className="text-2xl underline">
            + New
          </Link>
        </div>
      </div>

      {(!projects || projects.length === 0) ? (
        redirect('/projects/new')
      ) : (
        <div className="divide-y">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="flex items-center justify-between py-6 group"
            >
              <div>
                <p className="text-2xl">{project.name}</p>
                <p className="text-xl opacity-50 mt-1">{project.app_url}</p>
              </div>
              <span className="text-2xl opacity-30 group-hover:opacity-60">→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
