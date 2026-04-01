import { createClient } from '@/lib/supabase/server'

export default async function SettingsPage() {
  const supabase = await createClient()

  const { data: user } = await supabase.auth.getUser()
  if (!user.user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name, slug, plan)')
    .eq('user_id', user.user.id)
    .limit(1)
    .single()

  const org = (membership?.organizations as unknown as {
    id: string; name: string; slug: string; plan: string
  }) ?? { id: '', name: 'Unknown', slug: '', plan: 'free' }

  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', org.id)

  return (
    <div className="max-w-lg space-y-8">
      <h1 className="text-lg">Settings</h1>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between py-1">
          <span className="opacity-40">Organization</span>
          <span>{org.name}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="opacity-40">Slug</span>
          <span>{org.slug}</span>
        </div>
        <div className="flex justify-between py-1">
          <span className="opacity-40">Plan</span>
          <span>{org.plan}</span>
        </div>
      </div>

      <div>
        <h2 className="text-sm opacity-40 mb-2">Members</h2>
        <div className="divide-y text-sm">
          {members?.map((member) => (
            <div key={member.user_id} className="flex items-center justify-between py-2">
              <span className="text-xs truncate max-w-xs">{member.user_id}</span>
              <span className="text-xs opacity-40">{member.role}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
