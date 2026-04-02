import { streamText, convertToModelMessages, tool, stepCountIs, type UIMessage } from 'ai'
import { z } from 'zod'
import { chatModel } from '@/lib/ai'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getOrCreateSession } from '@/lib/chat/session'
import { buildChatContext, maybeSummarizeOlderMessages } from '@/lib/chat/context'
import { generateFlowProposals, serializeFlowsForMessage } from '@/lib/chat/flow-generator'
import { gatherIntegrationContext } from '@/lib/chat/integration-context'
import { triggerTestRun } from '@/lib/modal'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 60

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await request.json()
  const { messages: uiMessages, projectId } = body as {
    messages: UIMessage[]
    projectId: string
  }

  if (!projectId) {
    return new Response('projectId is required', { status: 400 })
  }

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) {
    return new Response('No organization found', { status: 404 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) {
    return new Response('Project not found', { status: 404 })
  }

  const serviceClient = createServiceRoleClient()
  const session = await getOrCreateSession(serviceClient, projectId)

  const lastMessage = uiMessages[uiMessages.length - 1]
  if (lastMessage && lastMessage.role === 'user') {
    const textContent = lastMessage.parts
      ?.filter((p: { type: string }) => p.type === 'text')
      .map((p: { type: string; text?: string }) => p.text ?? '')
      .join('') ?? ''

    if (textContent) {
      await serviceClient.from('chat_messages').insert({
        session_id: session.id,
        role: 'user',
        content: textContent,
      })
    }
  }

  const { contextSummary } = await buildChatContext(serviceClient, session.id)

  const [integrationContext, recentRunsResult, proposalMessagesResult, integrationsResult] = await Promise.all([
    gatherIntegrationContext(serviceClient, projectId),
    serviceClient
      .from('test_runs')
      .select('id, status, summary, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(3),
    serviceClient
      .from('chat_messages')
      .select('metadata')
      .eq('session_id', session.id)
      .not('metadata->type', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1),
    serviceClient
      .from('integrations')
      .select('type, status')
      .eq('project_id', projectId),
  ])

  const recentRuns = recentRunsResult.data
  const activeIntegrations = (integrationsResult.data ?? []).filter((i) => i.status === 'active').map((i) => i.type)
  const disconnectedIntegrations = ['github', 'posthog', 'sentry', 'langsmith', 'braintrust', 'slack'].filter(
    (t) => !activeIntegrations.includes(t as typeof activeIntegrations[number]),
  )

  let integrationDataSection = ''
  if (integrationContext.commits.length > 0) {
    integrationDataSection += `\n## Recent Git Commits (${integrationContext.commits.length})\n${JSON.stringify(integrationContext.commits.slice(0, 15), null, 2)}\n`
  }
  if (integrationContext.errorEvents.length > 0) {
    integrationDataSection += `\n## Error Events from PostHog (${integrationContext.errorEvents.length})\n${JSON.stringify(integrationContext.errorEvents.slice(0, 10), null, 2)}\n`
  }
  if (integrationContext.topPages.length > 0) {
    integrationDataSection += `\n## Top Pages from PostHog\n${JSON.stringify(integrationContext.topPages.slice(0, 10), null, 2)}\n`
  }
  if (integrationContext.sessionRecordings.length > 0) {
    integrationDataSection += `\n## Recent Session Recordings (${integrationContext.sessionRecordings.length})\n${JSON.stringify(integrationContext.sessionRecordings.slice(0, 10), null, 2)}\n`
  }
  if (integrationContext.sentryIssues.length > 0) {
    integrationDataSection += `\n## Sentry Issues (${integrationContext.sentryIssues.length})\n${JSON.stringify(integrationContext.sentryIssues.slice(0, 10), null, 2)}\n`
  }
  if (integrationContext.existingTemplates.length > 0) {
    integrationDataSection += `\n## Existing Test Templates (avoid duplicates)\n${JSON.stringify(integrationContext.existingTemplates, null, 2)}\n`
  }

  const latestProposals = proposalMessagesResult.data?.[0]?.metadata as Record<string, Json> | null
  const flowStates = (latestProposals?.flow_states ?? {}) as Record<string, string>
  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length

  let flowStatusSummary = ''
  if (latestProposals?.type === 'flow_proposals') {
    const proposals = latestProposals.proposals as { flows: Array<{ id: string; name: string }> }
    flowStatusSummary = '\n\nCurrent flow states:\n' + proposals.flows
      .map((f) => `- ${f.name}: ${flowStates[f.id] ?? 'pending'}`)
      .join('\n')
  }

  const systemPrompt = `You are Verona, an AI QA strategist that helps teams plan and execute UI testing for their web applications. You are assisting with the project "${project.name}" at ${project.app_url}.

Connected integrations: ${activeIntegrations.length > 0 ? activeIntegrations.join(', ') : 'none'}
Not connected: ${disconnectedIntegrations.length > 0 ? disconnectedIntegrations.join(', ') : 'all connected'}

${integrationDataSection ? `# Live Integration Data\nThe following data was fetched from the user's connected integrations:\n${integrationDataSection}` : 'No integration data is available. The user has not connected integrations, or they returned no recent data.'}

Your capabilities:
1. Propose UI test flows based on the integration data above
2. Refine test flows based on user feedback
3. Trigger test execution when the user is ready

Communication style:
- Be concise and actionable
- When proposing flows, always explain WHY each flow is recommended, referencing specific commits, errors, or pages from the data above
- When the user provides feedback, acknowledge it and explain how you'll incorporate it
- If the user asks about integration data you don't have, tell them which integration to connect and where (project Settings → Integrations)

${contextSummary ? `Previous conversation context:\n${contextSummary}\n` : ''}
${flowStatusSummary}

${recentRuns && recentRuns.length > 0 ? `Recent test runs:\n${JSON.stringify(recentRuns, null, 2)}\n` : ''}

When the user wants to generate or refresh test flow proposals, use the generate_flow_proposals tool.
When the user approves flows and wants to start testing (says things like "go", "start testing", "run the tests", "kick it off", etc.), use the start_test_run tool.`

  const modelMessages = await convertToModelMessages(uiMessages)

  const result = streamText({
    model: chatModel,
    system: systemPrompt,
    messages: modelMessages,
    tools: {
      generate_flow_proposals: tool({
        description: 'Generate structured UI test flow proposals with approval cards. Use this when the user asks to generate, refresh, or create new test flow proposals.',
        inputSchema: z.object({
          reason: z.string().describe('Brief reason for generating proposals'),
        }),
        execute: async (_input) => {
          const freshContext = await gatherIntegrationContext(serviceClient, projectId)
          const proposals = await generateFlowProposals(project.app_url, freshContext)
          const { content, metadata } = serializeFlowsForMessage(proposals)

          await serviceClient.from('chat_messages').insert({
            session_id: session.id,
            role: 'assistant',
            content,
            metadata: metadata as unknown as Json,
          })

          return {
            success: true,
            analysis: proposals.analysis,
            flowCount: proposals.flows.length,
            flows: proposals.flows.map((f) => ({
              id: f.id,
              name: f.name,
              description: f.description,
              rationale: f.rationale,
              priority: f.priority,
              stepCount: f.steps.length,
            })),
          }
        },
      }),
      start_test_run: tool({
        description: 'Start executing the approved test flows. Creates test templates from approved flows and triggers a test run.',
        inputSchema: z.object({
          confirmation: z.string().describe('Brief confirmation message'),
        }),
        execute: async (_input) => {
          if (approvedCount === 0) {
            return {
              success: false,
              error: 'No approved flows. The user needs to approve at least one flow before starting.',
            }
          }

          const proposals = latestProposals?.proposals as {
            flows: Array<{
              id: string
              name: string
              description: string
              steps: Array<{
                order: number
                instruction: string
                type: string
                url?: string
                expected?: string
                timeout?: number
              }>
            }>
          }

          const approvedFlows = proposals.flows.filter((f) => flowStates[f.id] === 'approved')

          const createdTemplateIds: string[] = []
          for (const flow of approvedFlows) {
            const { data: template, error } = await serviceClient
              .from('test_templates')
              .insert({
                project_id: projectId,
                name: flow.name,
                description: flow.description,
                steps: flow.steps as unknown as Json,
                source: 'chat_generated',
              })
              .select('id')
              .single()

            if (template) {
              createdTemplateIds.push(template.id)
            }
            if (error) {
              console.error('Failed to create template:', error)
            }
          }

          const { data: testRun, error: runError } = await serviceClient
            .from('test_runs')
            .insert({
              project_id: projectId,
              trigger: 'chat',
              status: 'pending',
            })
            .select()
            .single()

          if (runError || !testRun) {
            return { success: false, error: `Failed to create test run: ${runError?.message}` }
          }

          try {
            const modalCallId = await triggerTestRun(testRun.id, projectId)
            await serviceClient
              .from('test_runs')
              .update({ modal_call_id: modalCallId })
              .eq('id', testRun.id)

            await serviceClient.from('chat_messages').insert({
              session_id: session.id,
              role: 'assistant',
              content: `Testing started! I'm executing ${approvedFlows.length} approved flow(s) in cloud browsers. I'll update you on progress as results come in.`,
              metadata: {
                type: 'test_run_started',
                run_id: testRun.id,
                template_ids: createdTemplateIds,
                flow_count: approvedFlows.length,
              } as unknown as Json,
            })

            return {
              success: true,
              runId: testRun.id,
              flowCount: approvedFlows.length,
              templateIds: createdTemplateIds,
            }
          } catch (error) {
            await serviceClient
              .from('test_runs')
              .update({
                status: 'failed',
                summary: { error: 'Failed to trigger Modal', details: String(error) } as unknown as Json,
              })
              .eq('id', testRun.id)

            return { success: false, error: `Failed to trigger test execution: ${String(error)}` }
          }
        },
      }),
    },
    stopWhen: stepCountIs(3),
    onFinish: async ({ text }) => {
      if (text) {
        await serviceClient.from('chat_messages').insert({
          session_id: session.id,
          role: 'assistant',
          content: text,
        })
      }

      await maybeSummarizeOlderMessages(serviceClient, session.id)
    },
  })

  return result.toUIMessageStreamResponse()
}
