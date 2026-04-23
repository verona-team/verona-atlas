import { ModalClient } from "modal"

let _client: ModalClient | null = null

function getClient(): ModalClient {
  if (!_client) {
    _client = new ModalClient()
  }
  return _client
}

/**
 * Trigger a test run on Modal.
 * Returns the Modal FunctionCall ID for tracking.
 */
export async function triggerTestRun(testRunId: string, projectId: string): Promise<string> {
  const client = getClient()
  const fn = await client.functions.fromName("atlas-runner", "execute_test_run")
  const call = await fn.spawn([testRunId, projectId])
  return call.functionCallId
}

/**
 * Spawn a chat-turn execution on Modal and return the FunctionCall id.
 *
 * The Modal function (`process_chat_turn`) writes directly into Supabase —
 * this is an enqueue + fire-and-forget. The caller is responsible for
 * persisting the returned id onto `chat_sessions.active_chat_call_id` so
 * duplicate POSTs can short-circuit and so the turn can be correlated with
 * its Modal invocation.
 *
 * Parameters:
 *   - `userMessageClientId`: the `UIMessage.id` the client assigned. Used
 *     by the Python worker for idempotency/trace correlation and to
 *     dedup its own current-turn row out of the historical context read.
 *   - `userMessageText`: the actual text of the user's message. Passed
 *     directly rather than having Python re-SELECT it from `chat_messages`
 *     after the route's upsert — that previously caused a
 *     read-your-writes race where the Python worker's read saw an empty
 *     list and Claude 400'd with "at least one message is required".
 *     The route-side upsert is still authoritative for durability across
 *     refreshes; this argument just gives the worker the current turn's
 *     content without needing the replica to have observed it yet.
 */
export async function triggerChatTurn(
  sessionId: string,
  projectId: string,
  userMessageClientId: string,
  userMessageText: string,
): Promise<string> {
  const client = getClient()
  const fn = await client.functions.fromName("atlas-runner", "process_chat_turn")
  const call = await fn.spawn([
    sessionId,
    projectId,
    userMessageClientId,
    userMessageText,
  ])
  return call.functionCallId
}

/**
 * Spawn a nightly analysis job for a single project. The Modal function
 * (`process_nightly_job`) runs the research agent, generates flow proposals,
 * inserts them into `chat_messages`, and optionally posts to Slack.
 *
 * Split from `triggerChatTurn` because nightly has no user message to
 * respond to and different idempotency semantics (each cron tick is a
 * new job, not a retry).
 */
export async function triggerNightlyJob(projectId: string): Promise<string> {
  const client = getClient()
  const fn = await client.functions.fromName("atlas-runner", "process_nightly_job")
  const call = await fn.spawn([projectId])
  return call.functionCallId
}

/**
 * Cancel an in-flight Modal FunctionCall (best-effort). Used from the API
 * route when a new chat turn arrives and we want to abort a stale one; the
 * Python side is already robust against disconnects, so this is purely for
 * cost and trace-cleanliness, not correctness.
 */
export async function cancelModalCall(functionCallId: string): Promise<void> {
  const client = getClient()
  const call = await client.functionCalls.fromId(functionCallId)
  await call.cancel()
}
