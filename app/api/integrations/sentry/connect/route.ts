import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/encryption'
import { validateSentryConnection } from '@/lib/sentry'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'

const SentryConnectSchema = z.object({
  projectId: z.string().uuid(),
  authToken: z.string().min(1),
  organizationSlug: z.string().min(1).max(100),
  projectSlug: z.string().min(1).max(100),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = SentryConnectSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { projectId, authToken, organizationSlug, projectSlug } = parsed.data

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

  const isValid = await validateSentryConnection({
    authToken,
    organizationSlug,
    projectSlug,
  })

  if (!isValid) {
    return NextResponse.json(
      { error: 'Could not connect to Sentry. Check your auth token, organization slug, and project slug.' },
      { status: 400 },
    )
  }

  const config: Json = {
    auth_token_encrypted: encrypt(authToken),
    organization_slug: organizationSlug,
    project_slug: projectSlug,
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'sentry')
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
      type: 'sentry',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
