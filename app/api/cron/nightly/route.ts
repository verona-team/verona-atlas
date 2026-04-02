import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { flushLangSmithTraces, getLangSmithTracingClient } from '@/lib/langsmith-ai'
import { getOrCreateSession } from '@/lib/chat/session'
import { runResearchAgent } from '@/lib/research-agent'
import { generateFlowProposals, serializeFlowsForMessage } from '@/lib/chat/flow-generator'
import { decrypt } from '@/lib/encryption'
import { postMessage } from '@/lib/slack'
import type { Json } from '@/lib/supabase/types'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (getLangSmithTracingClient()) {
    after(async () => {
      await flushLangSmithTraces()
    })
  }

  const supabase = createServiceRoleClient()
  const nowUtc = new Date()

  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, app_url, timezone, schedule_enabled, schedule_time, schedule_days, org_id')
    .eq('schedule_enabled', true)

  if (!projects || projects.length === 0) {
    return NextResponse.json({ message: 'No scheduled projects', processed: 0 })
  }

  let processed = 0

  for (const project of projects) {
    try {
      const tz = project.timezone || 'America/New_York'
      const localTime = new Date(nowUtc.toLocaleString('en-US', { timeZone: tz }))
      const localHour = localTime.getHours()
      const localDay = localTime.getDay()

      const [scheduleHour] = (project.schedule_time || '21:00').split(':').map(Number)

      if (localHour !== scheduleHour) continue

      const days = (project.schedule_days as string[]) || ['mon', 'tue', 'wed', 'thu', 'fri']
      const activeDayNumbers = days.map((d) => DAY_MAP[d]).filter((n) => n !== undefined)
      if (!activeDayNumbers.includes(localDay)) continue

      const gh = await getGithubIntegrationReady(supabase, project.id)
      if (!gh.ok) {
        console.warn(`Nightly: skip project ${project.id} — ${gh.reason}`)
        continue
      }

      const session = await getOrCreateSession(supabase, project.id)

      const report = await runResearchAgent(supabase, project.id, project.app_url)

      await supabase
        .from('chat_sessions')
        .update({
          research_report: report as unknown as Json,
          updated_at: new Date().toISOString(),
        })
        .eq('id', session.id)

      const proposals = await generateFlowProposals(project.app_url, report)
      const { content, metadata } = serializeFlowsForMessage(proposals)

      await supabase.from('chat_messages').insert({
        session_id: session.id,
        role: 'assistant',
        content: `🌙 Nightly analysis complete. ${content}`,
        metadata: metadata as unknown as Json,
      })

      const { data: integrations } = await supabase
        .from('integrations')
        .select('*')
        .eq('project_id', project.id)
        .eq('status', 'active')
        .eq('type', 'slack')

      const slackIntegration = integrations?.[0]
      if (slackIntegration) {
        const config = slackIntegration.config as Record<string, Json>
        const botTokenEncrypted = config.bot_token_encrypted as string
        const channelId = config.channel_id as string

        if (botTokenEncrypted && channelId) {
          const botToken = decrypt(botTokenEncrypted)
          const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? ''
          const chatUrl = `${appUrl}/projects/${project.id}/chat`

          await postMessage(botToken, channelId, [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `🧪 *Verona* has suggested *${proposals.flows.length} new test flows* for *${project.name}*.\n\n${report.summary}`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<${chatUrl}|Review test flows in Verona →>`,
              },
            },
          ], `Verona: ${proposals.flows.length} new test flows for ${project.name}`)
        }
      }

      processed++
    } catch (error) {
      console.error(`Nightly cron failed for project ${project.id}:`, error)
    }
  }

  return NextResponse.json({ message: 'Nightly cron complete', processed })
}
