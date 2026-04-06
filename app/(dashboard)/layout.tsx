import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { WorkspaceProvider } from '@/lib/workspace-context'
import { AppSidebar } from '@/components/dashboard/sidebar'
import { AppHeader } from '@/components/dashboard/topbar'
import { NewProjectModal } from '@/components/dashboard/new-project-modal'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)

  if (!user) {
    redirect('/login')
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, organizations(name)')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  const orgId = membership?.org_id ?? ''
  const orgName =
    (membership?.organizations as unknown as { name: string } | null)?.name ?? ''

  const { data: projects } = orgId
    ? await supabase
        .from('projects')
        .select('*')
        .eq('org_id', orgId)
        .order('updated_at', { ascending: false })
    : { data: [] as never[] }

  return (
    <WorkspaceProvider
      orgId={orgId}
      orgName={orgName}
      userEmail={user.email ?? ''}
      initialProjects={projects ?? []}
    >
      <div className="flex h-screen overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <AppHeader />
          <main className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
      <NewProjectModal />
    </WorkspaceProvider>
  )
}
