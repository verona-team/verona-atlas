import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { MenuBar } from '@/components/dashboard/menu-bar'

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
    .select('organizations(id, name, slug)')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  const org = (membership?.organizations as unknown as { id: string; name: string; slug: string }) ?? {
    id: '',
    name: 'My Organization',
    slug: 'my-org',
  }

  return (
    <div className="terminal-ui flex h-screen flex-col overflow-hidden">
      <MenuBar userEmail={user.email ?? ''} orgName={org.name} />
      <main className="flex-1 overflow-y-auto px-8 py-10 md:px-16 lg:px-24">
        {children}
      </main>
    </div>
  )
}
