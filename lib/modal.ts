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
