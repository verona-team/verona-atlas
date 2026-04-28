import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { getPostHogClient } from '@/lib/posthog-server'

type RouteContext = { params: Promise<{ projectId: string }> }

/**
 * Flip `projects.bootstrap_dispatched_at` from NULL → now() for a project the
 * user is a member of. Idempotent: if the column is already non-null we leave
 * the original timestamp alone (double-click, tab duplication, reload races).
 *
 * This is the arming step for the deferred-bootstrap UX — see the migration
 * 028 header and `components/chat/project-setup-cta.tsx`. Setting this flag
 * causes `ProjectChatGate` to mount `<ChatInterface>`, whose existing empty-
 * thread `useEffect` then sends the bootstrap user turn to `/api/chat`.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { projectId } = await context.params
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership)
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })

  // Fetch first so we can (a) confirm membership for this specific project
  // and (b) short-circuit without a write when already armed. The select
  // comes from the same org-scoped table, so a missing row means either the
  // project doesn't exist or belongs to another org — both map to 404.
  const { data: project } = await supabase
    .from('projects')
    .select('id, bootstrap_dispatched_at')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (project.bootstrap_dispatched_at) {
    return NextResponse.json({ dispatchedAt: project.bootstrap_dispatched_at })
  }

  const nowIso = new Date().toISOString()
  const { data: updated, error } = await supabase
    .from('projects')
    .update({ bootstrap_dispatched_at: nowIso })
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    // Extra guard against the TOCTOU between the select above and this
    // update — if another request armed the project in the meantime, we
    // don't overwrite its timestamp.
    .is('bootstrap_dispatched_at', null)
    .select('bootstrap_dispatched_at')
    .maybeSingle()

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 })

  if (updated) {
    getPostHogClient().capture({
      distinctId: user.id,
      event: 'project_bootstrapped',
      properties: { project_id: projectId },
    })
  }

  return NextResponse.json({
    dispatchedAt: updated?.bootstrap_dispatched_at ?? nowIso,
  })
}
