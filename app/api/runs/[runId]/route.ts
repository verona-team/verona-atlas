import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params
  const supabase = await createClient()

  const user = await getServerUser(supabase)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch the run
  const { data: run, error: runError } = await supabase
    .from('test_runs')
    .select('*')
    .eq('id', runId)
    .single()

  if (runError || !run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  // Verify user has access via project → org
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
    .select('id, name')
    .eq('id', run.project_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Fetch test results for this run
  const { data: results } = await supabase
    .from('test_results')
    .select('*, test_templates(id, name)')
    .eq('test_run_id', runId)
    .order('created_at', { ascending: true })

  return NextResponse.json({
    run,
    results: results || [],
    project,
  })
}
