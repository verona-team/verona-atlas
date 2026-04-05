import type { UIMessage } from 'ai'

export type AgentActionStatus = 'running' | 'complete' | 'error'

export type AgentActionIntegration =
  | 'github'
  | 'posthog'
  | 'sentry'
  | 'langsmith'
  | 'braintrust'
  | 'codebase'
  | 'system'

export interface AgentActionData {
  actionId: string
  integration: AgentActionIntegration
  label: string
  detail?: string
  status: AgentActionStatus
  startedAt: number
  completedAt?: number
}

export type AgentActionsMessage = UIMessage<
  never,
  {
    'agent-action': AgentActionData
  }
>

export type ProgressCallback = (action: {
  actionId: string
  integration: AgentActionIntegration
  label: string
  detail?: string
  status: AgentActionStatus
}) => void
