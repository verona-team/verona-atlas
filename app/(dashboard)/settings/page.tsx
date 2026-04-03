import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'

export default async function SettingsPage() {
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name, slug, plan)')
    .eq('user_id', user.id)
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
    <div className="max-w-4xl mx-auto space-y-14">
      <h1 className="text-5xl">Settings</h1>

      <div className="space-y-4 text-2xl">
        <div className="flex justify-between py-2">
          <span className="opacity-50">Organization</span>
          <span>{org.name}</span>
        </div>
        <div className="flex justify-between py-2">
          <span className="opacity-50">Slug</span>
          <span>{org.slug}</span>
        </div>
        <div className="flex justify-between py-2">
          <span className="opacity-50">Plan</span>
          <span>{org.plan}</span>
        </div>
      </div>

      <div>
        <h2 className="text-2xl opacity-50 mb-4">Members</h2>
        <div className="divide-y text-2xl">
          {members?.map((member) => (
            <div key={member.user_id} className="flex items-center justify-between py-4">
              <span className="text-xl truncate max-w-md">{member.user_id}</span>
              <span className="text-xl opacity-50">{member.role}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
