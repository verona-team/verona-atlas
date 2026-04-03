import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { triggerTestRun } from '@/lib/modal'
import { z } from 'zod'

const TriggerSchema = z.object({
  project_id: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = TriggerSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { project_id } = parsed.data

  // Verify user has access to this project
  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, org_id')
    .eq('id', project_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Create test_run record
  const { data: testRun, error: createError } = await supabase
    .from('test_runs')
    .insert({
      project_id,
      trigger: 'manual',
      status: 'pending',
    })
    .select()
    .single()

  if (createError || !testRun) {
    return NextResponse.json(
      { error: createError?.message || 'Failed to create test run' },
      { status: 500 }
    )
  }

  // Trigger Modal function
  try {
    const modalCallId = await triggerTestRun(testRun.id, project_id)

    // Store modal_call_id
    await supabase
      .from('test_runs')
      .update({ modal_call_id: modalCallId })
      .eq('id', testRun.id)

    return NextResponse.json({
      id: testRun.id,
      status: testRun.status,
      modal_call_id: modalCallId,
    }, { status: 201 })
  } catch (error) {
    // If Modal trigger fails, mark run as failed
    await supabase
      .from('test_runs')
      .update({
        status: 'failed',
        summary: { error: 'Failed to trigger Modal function', details: String(error) },
      })
      .eq('id', testRun.id)

    return NextResponse.json(
      { error: 'Failed to trigger test run', details: String(error) },
      { status: 500 }
    )
  }
}
