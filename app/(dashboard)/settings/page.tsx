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
    id: string
    name: string
    slug: string
    plan: string
  }) ?? { id: '', name: 'Unknown', slug: '', plan: 'free' }

  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', org.id)

  return (
    <div className="max-w-2xl mx-auto">
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          System Info
        </div>
        <div className="window-body space-y-4">
          <div className="border-2 border-[#1a1a1a] divide-y-2 divide-[#1a1a1a] text-sm">
            <div className="flex justify-between px-3 py-2">
              <span className="text-[#6b6555] uppercase text-xs tracking-wider">Organization</span>
              <span className="text-[#1a1a1a]">{org.name}</span>
            </div>
            <div className="flex justify-between px-3 py-2">
              <span className="text-[#6b6555] uppercase text-xs tracking-wider">Slug</span>
              <span className="text-[#1a1a1a]">{org.slug}</span>
            </div>
            <div className="flex justify-between px-3 py-2">
              <span className="text-[#6b6555] uppercase text-xs tracking-wider">Plan</span>
              <span className="text-[#1a1a1a] uppercase">{org.plan}</span>
            </div>
          </div>

          <div>
            <p className="text-xs text-[#6b6555] uppercase tracking-wider mb-2">
              Members ({members?.length ?? 0})
            </p>
            <div className="border-2 border-[#1a1a1a] divide-y divide-[#b8b3a4] text-sm">
              {members?.map((member) => (
                <div
                  key={member.user_id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <span className="text-xs truncate max-w-xs text-[#1a1a1a]">{member.user_id}</span>
                  <span className="text-[10px] uppercase tracking-wider border border-[#b8b3a4] px-2 py-0.5 text-[#6b6555]">
                    {member.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
