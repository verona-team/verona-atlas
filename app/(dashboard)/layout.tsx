import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { MenuBar } from '@/components/dashboard/menu-bar'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

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
    <div className="flex h-screen flex-col overflow-hidden">
      <MenuBar userEmail={user.email ?? ''} orgName={org.name} />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        {children}
      </main>
      <footer className="border-t border-border px-4 py-1 text-[11px] text-phosphor-dim flex justify-between">
        <span>VERONA QA SYSTEM v1.0</span>
        <span>{new Date().getFullYear()} — ALL RIGHTS RESERVED</span>
      </footer>
    </div>
  )
}
