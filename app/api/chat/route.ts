import { streamText, convertToModelMessages, tool, stepCountIs, type UIMessage } from 'ai'
import { z } from 'zod'
import { model } from '@/lib/ai'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getOrCreateSession } from '@/lib/chat/session'
import { buildChatContext, maybeSummarizeOlderMessages } from '@/lib/chat/context'
import { generateFlowProposals, serializeFlowsForMessage } from '@/lib/chat/flow-generator'
import { runResearchAgent, type ResearchReport } from '@/lib/research-agent'
import { triggerTestRun } from '@/lib/modal'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 800

async function getOrRunResearch(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  sessionId: string,
  projectId: string,
  appUrl: string,
  forceRefresh = false,
): Promise<ResearchReport> {
  if (!forceRefresh) {
    const { data: session } = await serviceClient
      .from('chat_sessions')
      .select('research_report')
      .eq('id', sessionId)
      .single()

    if (session?.research_report) {
      return session.research_report as unknown as ResearchReport
    }
  }

  const report = await runResearchAgent(serviceClient, projectId, appUrl)

  await serviceClient
    .from('chat_sessions')
    .update({
      research_report: report as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)

  return report
}

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

  const report = await getOrRunResearch(serviceClient, session.id, projectId, project.app_url)

  const { data: recentRuns } = await serviceClient
    .from('test_runs')
    .select('id, status, summary, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(3)

  const { data: proposalMessages } = await serviceClient
    .from('chat_messages')
    .select('metadata')
    .eq('session_id', session.id)
    .not('metadata->type', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)

  const latestProposals = proposalMessages?.[0]?.metadata as Record<string, Json> | null
  const flowStates = (latestProposals?.flow_states ?? {}) as Record<string, string>
  const approvedCount = Object.values(flowStates).filter((s) => s === 'approved').length

  let flowStatusSummary = ''
  if (latestProposals?.type === 'flow_proposals') {
    const proposals = latestProposals.proposals as { flows: Array<{ id: string; name: string }> }
    flowStatusSummary = '\n\nCurrent flow states:\n' + proposals.flows
      .map((f) => `- ${f.name}: ${flowStates[f.id] ?? 'pending'}`)
      .join('\n')
  }

  const findingsSummary = report.findings.length > 0
    ? report.findings.map((f) => `- [${f.source}/${f.severity}] ${f.details}`).join('\n')
    : 'No specific findings from integrations.'

  const systemPrompt = `You are Verona, an AI QA strategist that helps teams plan and execute UI testing for their web applications. You are assisting with the project "${project.name}" at ${project.app_url}.

# Research Report
A deep analysis agent investigated the user's connected integrations and found:

## Summary
${report.summary}

## Key Findings
${findingsSummary}

## Recommended Flows
${report.recommendedFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Integrations covered: ${report.integrationsCovered.join(', ') || 'none'}

# Instructions
- Be concise and actionable
- When proposing or discussing flows, reference specific findings from the research report above
- When the user provides feedback, acknowledge it and explain how you'll incorporate it
- If the user asks about data from an integration not listed in "integrations covered", tell them to connect it in Settings

${contextSummary ? `Previous conversation context:\n${contextSummary}\n` : ''}
${flowStatusSummary}

${recentRuns && recentRuns.length > 0 ? `Recent test runs:\n${JSON.stringify(recentRuns, null, 2)}\n` : ''}

When the user wants to generate or refresh test flow proposals, use the generate_flow_proposals tool.
When the user approves flows and wants to start testing, use the start_test_run tool.`

  const modelMessages = await convertToModelMessages(uiMessages)

  const result = streamText({
    model,
    system: systemPrompt,
    messages: modelMessages,
    tools: {
      generate_flow_proposals: tool({
        description: 'Generate structured UI test flow proposals with approval cards based on the research report. Use this when the user first asks to analyze their project, or when they want to refresh proposals.',
        inputSchema: z.object({
          reason: z.string().describe('Brief reason for generating proposals'),
          refresh: z.boolean().optional().describe('If true, re-run the research agent to get fresh data before generating proposals'),
        }),
        execute: async ({ refresh }) => {
          const currentReport = refresh
            ? await getOrRunResearch(serviceClient, session.id, projectId, project.app_url, true)
            : report

          const proposals = await generateFlowProposals(project.app_url, currentReport)
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
