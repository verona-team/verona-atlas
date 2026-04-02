import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    const { data: membership } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', user.id)
      .limit(1)
      .single()

    if (membership) {
      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('org_id', membership.org_id)
        .single()

      if (project) {
        const gh = await getGithubIntegrationReady(supabase, projectId)
        if (!gh.ok) {
          redirect(`/projects/${projectId}/setup`)
        }
      }
    }
  }

  redirect(`/projects/${projectId}/chat`)
}
