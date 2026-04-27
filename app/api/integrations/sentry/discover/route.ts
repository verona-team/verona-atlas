import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { fetchAccessibleProjects, SentryAuthError } from '@/lib/sentry'
import { z } from 'zod'

const SentryDiscoverSchema = z.object({
  authToken: z.string().min(1),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = SentryDiscoverSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  try {
    const projects = await fetchAccessibleProjects(parsed.data.authToken)
    return NextResponse.json({ projects })
  } catch (err) {
    if (err instanceof SentryAuthError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    const message = err instanceof Error ? err.message : 'Failed to reach Sentry'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
