import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { encrypt } from '@/lib/encryption'
import { validateBraintrustConnection } from '@/lib/braintrust'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'
import { getPostHogClient } from '@/lib/posthog-server'

const BraintrustConnectSchema = z.object({
  projectId: z.string().uuid(),
  apiKey: z.string().min(1),
  braintrustProjectName: z.string().optional(),
  apiUrl: z.string().url().optional(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = BraintrustConnectSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { projectId, apiKey, braintrustProjectName, apiUrl } = parsed.data

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

  const isValid = await validateBraintrustConnection({ apiKey, apiUrl })
  if (!isValid) {
    return NextResponse.json(
      { error: 'Could not connect to Braintrust. Check your API key.' },
      { status: 400 },
    )
  }

  const config: Json = {
    api_key_encrypted: encrypt(apiKey),
    project_name: braintrustProjectName || null,
    api_url: apiUrl || 'https://api.braintrust.dev',
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'braintrust')
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
      type: 'braintrust',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  getPostHogClient().capture({
    distinctId: user.id,
    event: 'braintrust_integration_connected',
    properties: {
      project_id: projectId,
      reconnected: !!existing,
    },
  })

  return NextResponse.json({ success: true })
}
