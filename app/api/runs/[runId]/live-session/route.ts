import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'

/**
 * Returns the Browserbase live view URL for a running test session.
 * Proxies the Browserbase debug API so the API key stays server-side.
 */
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

  const { data: run } = await supabase
    .from('test_runs')
    .select('id, project_id, live_session, status')
    .eq('id', runId)
    .single()

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  // Verify user has access
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
    .select('id')
    .eq('id', run.project_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const liveSession = run.live_session as {
    browserbase_session_id?: string
    template_name?: string
    template_id?: string
    started_at?: string
  } | null

  if (!liveSession?.browserbase_session_id) {
    return NextResponse.json({ active: false })
  }

  const bbApiKey = process.env.BROWSERBASE_API_KEY
  if (!bbApiKey) {
    return NextResponse.json(
      { error: 'Browserbase API key not configured' },
      { status: 500 }
    )
  }

  try {
    const debugRes = await fetch(
      `https://api.browserbase.com/v1/sessions/${liveSession.browserbase_session_id}/debug`,
      { headers: { 'x-bb-api-key': bbApiKey } }
    )

    if (!debugRes.ok) {
      return NextResponse.json({ active: false })
    }

    const debugData = (await debugRes.json()) as {
      debuggerFullscreenUrl: string
      debuggerUrl: string
      pages: Array<{ debuggerFullscreenUrl: string }>
    }

    return NextResponse.json({
      active: true,
      liveViewUrl: debugData.debuggerFullscreenUrl,
      debuggerUrl: debugData.debuggerUrl,
      templateName: liveSession.template_name,
      templateId: liveSession.template_id,
      startedAt: liveSession.started_at,
      pages: debugData.pages,
    })
  } catch {
    return NextResponse.json({ active: false })
  }
}
