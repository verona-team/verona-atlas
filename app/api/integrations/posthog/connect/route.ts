import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { encrypt } from '@/lib/encryption'
import { z } from 'zod'
import type { Json } from '@/lib/supabase/types'

const PostHogConnectSchema = z.object({
  projectId: z.string().uuid(),
  posthogApiKey: z.string().min(1),
  posthogProjectId: z.string().min(1),
  apiHost: z.string().url().optional(),
})

async function validatePosthogCredentials(
  apiKey: string,
  projectId: string,
  apiHost?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const host = (
    apiHost || process.env.POSTHOG_API_HOST || 'https://us.posthog.com'
  ).replace(/\/$/, '')

  const res = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    return {
      ok: false,
      message: `PostHog API error (${res.status}): ${text.slice(0, 240)}`,
    }
  }

  return { ok: true }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = PostHogConnectSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const { projectId, posthogApiKey, posthogProjectId, apiHost: customApiHost } = parsed.data

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

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const validation = await validatePosthogCredentials(posthogApiKey, posthogProjectId, customApiHost)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.message }, { status: 400 })
  }

  const apiKeyEncrypted = encrypt(posthogApiKey)
  const resolvedHost = (
    customApiHost || process.env.POSTHOG_API_HOST || 'https://us.posthog.com'
  ).replace(/\/$/, '')
  const config: Json = {
    posthog_project_id: posthogProjectId,
    api_key_encrypted: apiKeyEncrypted,
    api_host: resolvedHost,
  }

  const { data: existing } = await supabase
    .from('integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'posthog')
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
      type: 'posthog',
      config,
      status: 'active',
    })

    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
