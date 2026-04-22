import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'

export default async function SettingsPage() {
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, plan)')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  const org = (membership?.organizations as unknown as {
    id: string; plan: string
  }) ?? { id: '', plan: 'free' }

  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', org.id)

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-lg font-medium">Organization Settings</h1>

      <div className="space-y-3">
        <div className="flex justify-between py-1.5 text-sm">
          <span className="text-muted-foreground">Plan</span>
          <span>{org.plan}</span>
        </div>
      </div>

      <div>
        <h2 className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Members</h2>
        <div className="divide-y divide-border">
          {members?.map((member) => (
            <div key={member.user_id} className="flex items-center justify-between py-2.5 text-sm">
              <span className="truncate max-w-md text-foreground/80 font-mono text-xs">{member.user_id}</span>
              <span className="text-muted-foreground text-xs">{member.role}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
