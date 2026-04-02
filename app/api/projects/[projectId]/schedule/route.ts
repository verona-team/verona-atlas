import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const ScheduleSchema = z.object({
  schedule_enabled: z.boolean().optional(),
  schedule_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  schedule_days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).optional(),
  timezone: z.string().optional(),
})

type RouteContext = { params: Promise<{ projectId: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  const { projectId } = await context.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) return NextResponse.json({ error: 'No organization' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('schedule_enabled, schedule_time, schedule_days, timezone')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(project)
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { projectId } = await context.params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = ScheduleSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) return NextResponse.json({ error: 'No organization' }, { status: 404 })

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.schedule_enabled !== undefined) updateData.schedule_enabled = parsed.data.schedule_enabled
  if (parsed.data.schedule_time !== undefined) updateData.schedule_time = parsed.data.schedule_time
  if (parsed.data.schedule_days !== undefined) updateData.schedule_days = parsed.data.schedule_days
  if (parsed.data.timezone !== undefined) updateData.timezone = parsed.data.timezone

  const { error } = await supabase
    .from('projects')
    .update(updateData)
    .eq('id', projectId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
