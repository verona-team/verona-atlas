import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  steps: z.array(z.object({
    order: z.number(),
    instruction: z.string(),
    type: z.enum(['navigate', 'action', 'assertion', 'extract', 'wait']),
    url: z.string().optional(),
    expected: z.string().optional(),
    timeout: z.number().optional(),
  })).optional(),
  is_active: z.boolean().optional(),
})

type RouteContext = { params: Promise<{ templateId: string }> }

async function getTemplateForUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  templateId: string,
) {
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .limit(1)
    .single()

  if (!membership) return null

  const { data: template } = await supabase
    .from('test_templates')
    .select('*, projects!inner(org_id)')
    .eq('id', templateId)
    .eq('projects.org_id', membership.org_id)
    .single()

  return template
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { templateId } = await context.params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const template = await getTemplateForUser(supabase, user.id, templateId)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(template)
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { templateId } = await context.params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = UpdateTemplateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const template = await getTemplateForUser(supabase, user.id, templateId)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.name !== undefined) update.name = parsed.data.name
  if (parsed.data.description !== undefined) update.description = parsed.data.description
  if (parsed.data.steps !== undefined) update.steps = parsed.data.steps
  if (parsed.data.is_active !== undefined) update.is_active = parsed.data.is_active

  const { data: updated, error } = await supabase
    .from('test_templates')
    .update(update)
    .eq('id', templateId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(updated)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { templateId } = await context.params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const template = await getTemplateForUser(supabase, user.id, templateId)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase.from('test_templates').delete().eq('id', templateId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return new NextResponse(null, { status: 204 })
}
