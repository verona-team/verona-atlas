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
          <div className="border border-border divide-y divide-border text-sm">
            <div className="flex justify-between px-3 py-2">
              <span className="text-phosphor-dim uppercase text-xs tracking-wider">Organization</span>
              <span>{org.name}</span>
            </div>
            <div className="flex justify-between px-3 py-2">
              <span className="text-phosphor-dim uppercase text-xs tracking-wider">Slug</span>
              <span>{org.slug}</span>
            </div>
            <div className="flex justify-between px-3 py-2">
              <span className="text-phosphor-dim uppercase text-xs tracking-wider">Plan</span>
              <span className="uppercase">{org.plan}</span>
            </div>
          </div>

          <div>
            <p className="text-xs text-phosphor-dim uppercase tracking-wider mb-2">
              Members ({members?.length ?? 0})
            </p>
            <div className="border border-border divide-y divide-border text-sm">
              {members?.map((member) => (
                <div
                  key={member.user_id}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <span className="text-xs truncate max-w-xs">{member.user_id}</span>
                  <span className="text-[10px] uppercase tracking-wider border border-border px-2 py-0.5">
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
