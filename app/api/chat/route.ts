import { convertToModelMessages, tool, stepCountIs, hasToolCall, type UIMessage } from 'ai'
import { after } from 'next/server'
import { z } from 'zod'
import { traceable } from 'langsmith/traceable'
import { model } from '@/lib/ai'
import {
  streamText,
  flushLangSmithTraces,
  createLangSmithProviderOptions,
  getLangSmithTracingClient,
} from '@/lib/langsmith-ai'
import { createClient } from '@/lib/supabase/server'
import { getServerUser } from '@/lib/supabase/server-user'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getOrCreateSession } from '@/lib/chat/session'
import { buildChatContext, maybeSummarizeOlderMessages } from '@/lib/chat/context'
import { generateFlowProposals, serializeFlowsForMessage } from '@/lib/chat/flow-generator'
import { runResearchAgent, type ResearchReport } from '@/lib/research-agent'
import { getGithubIntegrationReady } from '@/lib/github-integration-guard'
import { normalizeResearchReport } from '@/lib/research-agent/types'
import { triggerTestRun } from '@/lib/modal'
import { chatServerLog } from '@/lib/chat/server-log'
import type { Json } from '@/lib/supabase/types'

export const maxDuration = 800

async function setSessionStatus(
  serviceClient: ReturnType<typeof createServiceRoleClient>,
  sessionId: string,
  status: 'idle' | 'thinking' | 'error',
) {
  await serviceClient
    .from('chat_sessions')
    .update({ status, status_updated_at: new Date().toISOString() })
    .eq('id', sessionId)
}

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
      return normalizeResearchReport(session.research_report)
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
  const lsClient = getLangSmithTracingClient()
  if (lsClient) {
    after(async () => {
      await flushLangSmithTraces()
    })
  }

  let logProjectId = ''
  let logSessionId = ''
  let logUserId = ''

  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }
  logUserId = user.id

  let body: { messages: UIMessage[]; projectId: string }
  try {
    body = (await request.json()) as { messages: UIMessage[]; projectId: string }
  } catch (err) {
    chatServerLog('error', 'chat_post_invalid_json', { err, userId: logUserId })
    return new Response('Invalid JSON body', { status: 400 })
  }

  const { messages: uiMessages, projectId } = body

  if (!projectId) {
    return new Response('projectId is required', { status: 400 })
  }
  logProjectId = projectId

  try {
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
    logSessionId = session.id

    await setSessionStatus(serviceClient, session.id, 'thinking')

    after(async () => {
      await setSessionStatus(serviceClient, session.id, 'idle')
    })

  /** Set when flow proposal DB insert fails so onFinish can persist a visible error. */
  let flowProposalInsertError: string | null = null

  const lastMessage = uiMessages[uiMessages.length - 1]
  let lastUserText = ''
  if (lastMessage && lastMessage.role === 'user') {
    lastUserText =
      lastMessage.parts
        ?.filter((p: { type: string }) => p.type === 'text')
        .map((p: { type: string; text?: string }) => p.text ?? '')
        .join('') ?? ''

    if (lastUserText) {
      const { error: userMsgErr } = await serviceClient.from('chat_messages').insert({
        session_id: session.id,
        role: 'user',
        content: lastUserText,
      })
      if (userMsgErr) {
        chatServerLog('warn', 'chat_user_message_persist_failed', {
          err: userMsgErr,
          projectId,
          sessionId: session.id,
          userId: user.id,
        })
      }
    }
  }

  const { contextSummary } = await buildChatContext(serviceClient, session.id)

  const ghReady = await getGithubIntegrationReady(serviceClient, projectId)
  if (!ghReady.ok) {
    await setSessionStatus(serviceClient, session.id, 'idle')
    return new Response(
      JSON.stringify({
        error: ghReady.reason,
        code: 'GITHUB_SETUP_REQUIRED',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

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
    .eq('metadata->>type', 'flow_proposals')
    .order('created_at', { ascending: false })
    .limit(1)

  const latestProposals = proposalMessages?.[0]?.metadata as Record<string, Json> | null
  const flowStates = (latestProposals?.flow_states ?? {}) as Record<string, string>

  let flowStatusSummary = ''
  if (latestProposals?.type === 'flow_proposals') {
    const proposals = latestProposals.proposals as { flows: Array<{ id: string; name: string }> }
    flowStatusSummary =
      '\n\nCurrent flow states:\n' +
      proposals.flows.map((f) => `- ${f.name}: ${flowStates[f.id] ?? 'pending'}`).join('\n')
  }

  const findingsSummary =
    report.findings.length > 0
      ? report.findings.map((f) => `- [${f.source}/${f.severity}] ${f.details}`).join('\n')
      : 'No specific findings from integrations.'

  const ce = report.codebaseExploration
  const codebaseBlock =
    ce && ce.summary
      ? `## Repository understanding (${ce.confidence} confidence)
${ce.summary}

**Architecture:** ${ce.architecture || '—'}

**Inferred user flows (from code):**
${ce.inferredUserFlows.length ? ce.inferredUserFlows.map((f, i) => `${i + 1}. ${f}`).join('\n') : '—'}

**Testing implications:** ${ce.testingImplications || '—'}

**Paths examined:** ${ce.keyPathsExamined.length ? ce.keyPathsExamined.slice(0, 40).join(', ') : '—'}
${ce.truncationWarnings.length ? `\n**Notes:** ${ce.truncationWarnings.join(' ')}` : ''}`
      : ''

  const hasExistingProposals = latestProposals?.type === 'flow_proposals'

  const systemPrompt = `You are Verona, an AI QA strategist helping teams plan and execute UI testing for their web app.

Project: "${project.name}" (${project.app_url})

# Tools — read carefully

You have two tools. The product's UI depends on them; do not try to substitute prose for tool output.

1. \`generate_flow_proposals\` — renders proposed test flows as structured, approvable cards in the chat UI. This is the ONLY way the user can approve a flow.
2. \`start_test_run\` — executes the flows the user has approved.

## When to call \`generate_flow_proposals\`

Call it whenever the user wants to see, propose, refresh, or add test flows — including the very first turn of a session, or phrasings like "suggest flows", "what should I test", "give me tests", "recommend flows", "propose more", "anything else to cover".

After the tool returns, reply with AT MOST two sentences that point the user at the cards and invite approval. Example: "I've proposed three flows above — approve the ones you want and tell me to start testing." Never repeat or re-describe the flows' names, steps, or rationales in prose; the cards already show them.

## When to call \`start_test_run\`

Call it when the user confirms they want to run approved flows ("start testing", "go", "run them", "let's do it"). After it returns, reply with one short sentence confirming execution started.

## What NOT to write in prose

Never write numbered lists, bullets, or prose that describes candidate flows ("Flow 1:", "Flow 2:", "Here are the flows I recommend:", "I suggest testing X, Y, Z"). If you catch yourself about to do this, stop and call \`generate_flow_proposals\` instead.

# Style

- Lead with the decision or answer in one short paragraph. Bullets only when they aid scanning.
- No preamble ("I'll analyze…", "Let me look at…"). No recap of the research report unless asked.
- When referencing findings, cite one concrete anchor per point (a commit, an error, a route, a rage-click count). One clause, not an essay.
- When the user gives feedback, acknowledge in one or two sentences and say what you'll do next.
- If the user asks about data from an integration not in "Integrations covered" below, tell them to connect it in Settings.

# Research report (background context — do not recite)

## Summary
${report.summary}

## Key findings
${findingsSummary}

${codebaseBlock}

## Recommended flow ideas (raw — use as input when calling \`generate_flow_proposals\`)
${report.recommendedFlows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Integrations covered: ${report.integrationsCovered.join(', ') || 'none'}

# Session state
${hasExistingProposals ? 'Flow proposals already exist for this session. Refer to them by name rather than regenerating, unless the user explicitly asks to refresh or add more.' : 'No flow proposals exist yet for this session.'}
${flowStatusSummary}
${contextSummary ? `\nPrior conversation summary:\n${contextSummary}` : ''}
${recentRuns && recentRuns.length > 0 ? `\nRecent test runs:\n${JSON.stringify(recentRuns, null, 2)}` : ''}`

  const modelMessages = await convertToModelMessages(uiMessages)

  const logChatTool = (
    level: 'error' | 'warn' | 'info',
    event: string,
    extra?: Record<string, unknown>,
  ) => {
    chatServerLog(level, event, {
      projectId,
      sessionId: session.id,
      userId: user.id,
      ...extra,
    })
  }

  const executeGenerateFlowProposals = traceable(
    async (input: { reason: string; refresh?: boolean }) => {
      try {
        const { refresh } = input
        const currentReport = refresh
          ? await getOrRunResearch(serviceClient, session.id, projectId, project.app_url, true)
          : report

        const proposals = await generateFlowProposals(project.app_url, currentReport)
        const { content, metadata, flows: persistedFlows } = serializeFlowsForMessage(proposals)

        const { error: insertError } = await serviceClient.from('chat_messages').insert({
          session_id: session.id,
          role: 'assistant',
          content,
          metadata: metadata as unknown as Json,
        })

        if (insertError) {
          flowProposalInsertError = insertError.message
          logChatTool('error', 'chat_tool_flow_proposals_db_insert_failed', {
            supabaseMessage: insertError.message,
            flowCount: persistedFlows.length,
          })
          return {
            success: false,
            error: insertError.message,
            analysis: proposals.analysis,
            flowCount: persistedFlows.length,
          }
        }

        logChatTool('info', 'chat_tool_flow_proposals_ok', { flowCount: persistedFlows.length })

        return {
          success: true,
          analysis: proposals.analysis,
          flowCount: persistedFlows.length,
          flows: persistedFlows.map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            rationale: f.rationale,
            priority: f.priority,
            stepCount: f.steps.length,
          })),
        }
      } catch (err) {
        logChatTool('error', 'chat_tool_flow_proposals_exception', { err })
        throw err
      }
    },
    {
      name: 'chat_tool_generate_flow_proposals',
      run_type: 'tool',
      ...(lsClient ? { client: lsClient } : {}),
      processInputs: (i) => ({ reason: i.reason, refresh: i.refresh }),
      processOutputs: (o) => ({
        success: o.success,
        flowCount: o.flowCount,
        flowNames: 'flows' in o && o.flows ? o.flows.map((f) => f.name) : undefined,
        error: 'error' in o ? o.error : undefined,
      }),
    },
  )

  const executeStartTestRun = traceable(
    async (input: { confirmation: string }) => {
      void input.confirmation

      try {
      const { data: freshProposalRows } = await serviceClient
        .from('chat_messages')
        .select('metadata')
        .eq('session_id', session.id)
        .eq('metadata->>type', 'flow_proposals')
        .order('created_at', { ascending: false })
        .limit(1)

      const freshMeta = freshProposalRows?.[0]?.metadata as Record<string, Json> | null
      const flowStatesAtRun = (freshMeta?.flow_states ?? {}) as Record<string, string>
      const approvedCountAtRun = Object.values(flowStatesAtRun).filter((s) => s === 'approved').length

      if (approvedCountAtRun === 0) {
        logChatTool('warn', 'chat_tool_start_test_run_no_approved_flows', {})
        return {
          success: false,
          error: 'No approved flows. The user needs to approve at least one flow before starting.',
        }
      }

      const proposals = freshMeta?.proposals as
        | {
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
        | undefined

      if (!proposals?.flows?.length) {
        logChatTool('warn', 'chat_tool_start_test_run_missing_proposals', {})
        return {
          success: false,
          error:
            'Could not find flow proposals for this session. Ask the user to generate proposals again, then approve flows before starting.',
        }
      }

      const approvedFlows = proposals.flows.filter((f) => flowStatesAtRun[f.id] === 'approved')

      if (approvedFlows.length === 0) {
        logChatTool('warn', 'chat_tool_start_test_run_no_matching_approved', {})
        return {
          success: false,
          error:
            'No approved flows match the current proposal set. Regenerate flow proposals or approve flows again, then start testing.',
        }
      }

      const createdTemplateIds: string[] = []
      const templateInsertErrors: string[] = []
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

        if (error || !template) {
          logChatTool('error', 'chat_tool_start_test_run_template_insert_failed', {
            flowName: flow.name,
            flowId: flow.id,
            supabaseMessage: error?.message,
          })
          templateInsertErrors.push(error?.message ?? 'Unknown error saving template')
          continue
        }
        createdTemplateIds.push(template.id)
      }

      if (createdTemplateIds.length !== approvedFlows.length) {
        logChatTool('error', 'chat_tool_start_test_run_partial_template_save', {
          approvedCount: approvedFlows.length,
          savedCount: createdTemplateIds.length,
          templateInsertErrors,
        })
        return {
          success: false,
          error:
            templateInsertErrors.length > 0
              ? `Could not save approved flows to the database, so cloud browsers were not started. ${templateInsertErrors.join(' ')}`
              : 'Could not save approved flows to the database, so cloud browsers were not started.',
        }
      }

      const { data: testRun, error: runError } = await serviceClient
        .from('test_runs')
        .insert({
          project_id: projectId,
          trigger: 'chat',
          status: 'pending',
          trigger_ref: JSON.stringify({ template_ids: createdTemplateIds }),
        })
        .select()
        .single()

      if (runError || !testRun) {
        logChatTool('error', 'chat_tool_start_test_run_db_insert_failed', {
          supabaseMessage: runError?.message,
        })
        return { success: false, error: `Failed to create test run: ${runError?.message}` }
      }

      try {
        const modalCallId = await triggerTestRun(testRun.id, projectId)
        await serviceClient.from('test_runs').update({ modal_call_id: modalCallId }).eq('id', testRun.id)

        const { error: startedMsgErr } = await serviceClient.from('chat_messages').insert({
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
        if (startedMsgErr) {
          logChatTool('warn', 'chat_tool_start_test_run_started_message_failed', {
            err: startedMsgErr,
            runId: testRun.id,
            modalCallId,
          })
        }

        logChatTool('info', 'chat_tool_start_test_run_modal_spawned', {
          runId: testRun.id,
          modalCallId,
          flowCount: approvedFlows.length,
          templateIds: createdTemplateIds,
        })

        return {
          success: true,
          runId: testRun.id,
          flowCount: approvedFlows.length,
          templateIds: createdTemplateIds,
        }
      } catch (error) {
        logChatTool('error', 'chat_tool_start_test_run_modal_failed', { err: error, runId: testRun.id })
        await serviceClient
          .from('test_runs')
          .update({
            status: 'failed',
            summary: { error: 'Failed to trigger Modal', details: String(error) } as unknown as Json,
          })
          .eq('id', testRun.id)

        return { success: false, error: `Failed to trigger test execution: ${String(error)}` }
      }
      } catch (err) {
        logChatTool('error', 'chat_tool_start_test_run_exception', { err })
        throw err
      }
    },
    {
      name: 'chat_tool_start_test_run',
      run_type: 'tool',
      ...(lsClient ? { client: lsClient } : {}),
      processInputs: (i) => ({ confirmationPreview: i.confirmation?.slice(0, 200) }),
      processOutputs: (o) => ({
        success: o.success,
        runId: 'runId' in o ? o.runId : undefined,
        flowCount: 'flowCount' in o ? o.flowCount : undefined,
        error: 'error' in o ? o.error : undefined,
      }),
    },
  )

  const langsmithStreamOpts = lsClient
    ? createLangSmithProviderOptions({
        name: 'verona_chat_stream',
        metadata: {
          projectId,
          sessionId: session.id,
          userId: user.id,
          projectName: project.name,
        },
        tags: ['verona', 'chat'],
      })
    : undefined

  const runChatTurn = traceable(
    async () => {
      const result = streamText({
        model,
        system: systemPrompt,
        messages: modelMessages,
        ...(langsmithStreamOpts
          ? { providerOptions: { langsmith: langsmithStreamOpts } }
          : {}),
        onError: ({ error }) => {
          logChatTool('error', 'chat_stream_text_error', { err: error })
        },
        tools: {
          generate_flow_proposals: tool({
            description:
              'Render up to 3 proposed UI test flows as structured approval cards in the chat UI. The user can only approve flows that come through this tool — prose descriptions cannot be approved. Call this any time the user asks to see, refresh, add, or propose test flows, or when bootstrapping a new session. Do not describe flows in your written reply; the cards already show the names, priorities, and steps.',
            inputSchema: z.object({
              reason: z
                .string()
                .describe('Why you are generating proposals now, e.g. "initial bootstrap" or "user asked for auth-focused flows".'),
              refresh: z
                .boolean()
                .optional()
                .describe('Set true only when the user explicitly asks for fresh data — re-runs the research agent before generating.'),
            }),
            execute: executeGenerateFlowProposals as (input: {
              reason: string
              refresh?: boolean
            }) => ReturnType<typeof executeGenerateFlowProposals>,
          }),
          start_test_run: tool({
            description:
              'Kick off a cloud browser run for every currently-approved flow. Call when the user confirms they want to start testing (phrases like "start testing", "run them", "go"). Requires at least one approved flow.',
            inputSchema: z.object({
              confirmation: z
                .string()
                .describe('Short paraphrase of the user\'s go-ahead, e.g. "user confirmed starting run".'),
            }),
            execute: executeStartTestRun as (input: {
              confirmation: string
            }) => ReturnType<typeof executeStartTestRun>,
          }),
        },
        /**
         * Stop after a successful proposals/run tool call so the model does
         * not run an extra step that rewrites the structured cards as prose.
         * The step count cap is a secondary safety net.
         */
        stopWhen: [
          stepCountIs(3),
          hasToolCall('generate_flow_proposals'),
          hasToolCall('start_test_run'),
        ],
        onFinish: async ({ text, finishReason, steps }) => {
          try {
            if (finishReason && finishReason !== 'stop') {
              logChatTool('warn', 'chat_stream_finish_non_stop', { finishReason })
            }
            /**
             * `streamText` in AI SDK v6 exposes only the FINAL step's text on
             * `onFinish({ text })`. When the model emits text across multiple
             * steps (e.g. preamble on step 0, final answer on step 1) the DB
             * was getting only step 1 while the client `useChat` stream kept
             * text from both. That mismatch made the client dedup miss and
             * rendered the response twice. Concatenate all step texts so the
             * DB row matches what the user saw during streaming.
             */
            const aggregatedText = steps
              .map((s) => s.text ?? '')
              .filter((t) => t.length > 0)
              .join('\n\n')
              .trim()
            const finalText = aggregatedText.length > 0 ? aggregatedText : text

            if (finalText) {
              const { error: assistantMsgErr } = await serviceClient.from('chat_messages').insert({
                session_id: session.id,
                role: 'assistant',
                content: finalText,
              })
              if (assistantMsgErr) {
                logChatTool('error', 'chat_assistant_message_persist_failed', {
                  err: assistantMsgErr,
                })
              }
            } else if (flowProposalInsertError) {
              const { error: fallbackErr } = await serviceClient.from('chat_messages').insert({
                session_id: session.id,
                role: 'assistant',
                content: `I couldn't save your flow proposals (${flowProposalInsertError}). Please try sending your message again, or refresh the page.`,
              })
              if (fallbackErr) {
                logChatTool('error', 'chat_flow_proposals_fallback_message_failed', {
                  err: fallbackErr,
                })
              }
            }

            try {
              await maybeSummarizeOlderMessages(serviceClient, session.id)
            } catch (err) {
              logChatTool('error', 'chat_summarize_messages_failed', { err })
            }
            await setSessionStatus(serviceClient, session.id, 'idle')
          } catch (err) {
            logChatTool('error', 'chat_on_finish_failed', { err })
            try {
              await setSessionStatus(serviceClient, session.id, 'error')
            } catch (statusErr) {
              logChatTool('error', 'chat_on_finish_set_session_error_failed', { err: statusErr })
            }
          }
        },
      })

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          logChatTool('error', 'chat_ui_message_stream_error', { err: error })
          return error instanceof Error ? error.message : 'Chat stream error'
        },
      })
    },
    {
      name: 'verona_chat_turn',
      ...(lsClient ? { client: lsClient } : {}),
      processInputs: () => ({
        projectId,
        sessionId: session.id,
        userId: user.id,
        lastUserMessagePreview: lastUserText.slice(0, 2000),
        messageCount: uiMessages.length,
        researchIntegrations: report.integrationsCovered,
        researchFindingsCount: report.findings.length,
      }),
    },
  )

  return runChatTurn()
  } catch (err) {
    chatServerLog('error', 'chat_post_unhandled_exception', {
      err,
      projectId: logProjectId || undefined,
      sessionId: logSessionId || undefined,
      userId: logUserId || undefined,
    })
    if (logSessionId) {
      try {
        const errorPathClient = createServiceRoleClient()
        await setSessionStatus(errorPathClient, logSessionId, 'error')
      } catch (statusErr) {
        chatServerLog('error', 'chat_post_set_session_error_failed', {
          err: statusErr,
          sessionId: logSessionId,
        })
      }
    }
    return new Response(
      JSON.stringify({ error: 'Chat request failed. Please try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
