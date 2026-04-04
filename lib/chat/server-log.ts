/**
 * Structured logs for chat/backend routes — readable in Vercel (JSON lines, searchable by `event`).
 */

export type ChatLogLevel = 'error' | 'warn' | 'info'

const PREFIX = '[verona-chat]'

function serializeError(err: unknown): Record<string, string | undefined> {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack }
  }
  return { message: String(err) }
}

/**
 * Log a chat-scoped event. Prefer `event` names like `chat_tool_start_test_run_failed`.
 */
export function chatServerLog(
  level: ChatLogLevel,
  event: string,
  context: Record<string, unknown> & { err?: unknown },
): void {
  const { err, ...rest } = context
  const payload: Record<string, unknown> = {
    scope: 'verona_chat',
    event,
    ...rest,
  }
  if (err !== undefined) {
    payload.error = serializeError(err)
  }
  const line = JSON.stringify(payload)
  if (level === 'error') {
    console.error(PREFIX, line)
  } else if (level === 'warn') {
    console.warn(PREFIX, line)
  } else {
    console.info(PREFIX, line)
  }
}
