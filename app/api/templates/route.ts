import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { z } from 'zod'

const CreateTemplateSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  steps: z.array(z.object({
    order: z.number(),
    instruction: z.string(),
    type: z.enum(['navigate', 'action', 'assertion', 'extract', 'wait']),
    url: z.string().optional(),
    expected: z.string().optional(),
    timeout: z.number().optional(),
  })),
  source: z.enum(['manual', 'ai_generated']).optional(),
})

async function verifyProjectAccess(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  projectId: string,
) {
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .limit(1)
    .single()

  if (!membership) return null

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  return project
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = request.nextUrl.searchParams.get('projectId')
  if (!projectId) {
    return NextResponse.json({ error: 'projectId query parameter is required' }, { status: 400 })
  }

  const project = await verifyProjectAccess(supabase, user.id, projectId)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: templates, error } = await supabase
    .from('test_templates')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(templates)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = CreateTemplateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { project_id, name, description, steps, source } = parsed.data

  const project = await verifyProjectAccess(supabase, user.id, project_id)
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: template, error } = await supabase
    .from('test_templates')
    .insert({
      project_id,
      name,
      description: description ?? null,
      steps: steps as unknown as import('@/lib/supabase/types').Json,
      source: source ?? 'manual',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(template, { status: 201 })
}
