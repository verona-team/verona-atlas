import { NextRequest, NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'
import { triggerNightlyJob } from '@/lib/modal'

/**
 * Nightly cron entrypoint. The old version ran the full research + flow
 * generator pipeline inline inside this Vercel function, which hit the same
 * durability problems as the old /api/chat (long-running LLM work coupled
 * to an HTTP handler). New version: enumerate projects that match the
 * cron schedule and spawn a Modal `process_nightly_job` for each. The
 * Python side (`runner/chat/nightly_pipeline.py`) does the full work.
 *
 * Behavior parity with the TS version:
 *   - Matches projects whose schedule_time hour == local hour, in their
 *     configured timezone.
 *   - Matches only on the days in schedule_days.
 *   - Skips projects without GitHub ready (same short-circuit the old
 *     inline version had).
 */

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceRoleClient()
  const nowUtc = new Date()

  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, timezone, schedule_enabled, schedule_time, schedule_days')
    .eq('schedule_enabled', true)

  if (!projects || projects.length === 0) {
    return NextResponse.json({ message: 'No scheduled projects', processed: 0 })
  }

  const spawnedCalls: Array<{ projectId: string; functionCallId: string }> = []
  const skipped: Array<{ projectId: string; reason: string }> = []

  for (const project of projects) {
    try {
      const tz = project.timezone || 'America/New_York'
      const localTime = new Date(nowUtc.toLocaleString('en-US', { timeZone: tz }))
      const localHour = localTime.getHours()
      const localDay = localTime.getDay()

      const [scheduleHour] = (project.schedule_time || '21:00').split(':').map(Number)
      if (localHour !== scheduleHour) {
        continue
      }

      const days = (project.schedule_days as string[]) || ['mon', 'tue', 'wed', 'thu', 'fri']
      const activeDayNumbers = days.map((d) => DAY_MAP[d]).filter((n) => n !== undefined)
      if (!activeDayNumbers.includes(localDay)) continue

      const gh = await getGithubIntegrationReady(supabase, project.id)
      if (!gh.ok) {
        skipped.push({ projectId: project.id, reason: gh.reason })
        continue
      }

      const functionCallId = await triggerNightlyJob(project.id)
      spawnedCalls.push({ projectId: project.id, functionCallId })
    } catch (error) {
      console.error(`Nightly cron failed to spawn for project ${project.id}:`, error)
      skipped.push({
        projectId: project.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return NextResponse.json({
    message: 'Nightly cron complete',
    processed: spawnedCalls.length,
    skipped: skipped.length,
    spawnedCalls,
  })
}
