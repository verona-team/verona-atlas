import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { encrypt } from '@/lib/encryption'
import { validateLangSmithConnection } from '@/lib/langsmith'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'

const LangSmithConnectSchema = z.object({
  projectId: z.string().uuid(),
  apiKey: z.string().min(1),
  projectName: z.string().optional(),
  apiUrl: z.string().url().optional(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = LangSmithConnectSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { projectId, apiKey, projectName, apiUrl } = parsed.data

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership)
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project)
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const isValid = await validateLangSmithConnection({ apiKey, apiUrl })
  if (!isValid) {
    return NextResponse.json(
      { error: 'Could not connect to LangSmith. Check your API key.' },
      { status: 400 },
    )
  }

  const config: Json = {
    api_key_encrypted: encrypt(apiKey),
    project_name: projectName || null,
    api_url: apiUrl || 'https://api.smith.langchain.com',
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'langsmith')
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('integrations')
      .update({ config, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', existing.id)

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await supabase.from('integrations').insert({
      project_id: projectId,
      type: 'langsmith',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
