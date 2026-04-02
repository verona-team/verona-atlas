import * as ai from 'ai'
import { Client } from 'langsmith'
import { wrapAISDK } from 'langsmith/experimental/vercel'

let _client: Client | undefined

export function getLangSmithTracingClient(): Client | undefined {
  const key = process.env.LANGSMITH_API_KEY
  if (!key) return undefined
  const tracing = process.env.LANGSMITH_TRACING
  if (tracing !== 'true' && tracing !== '1') return undefined
  _client ??= new Client()
  return _client
}

const lsClient = getLangSmithTracingClient()
const wrapped = wrapAISDK(ai, lsClient ? { client: lsClient } : {})

export const generateText = wrapped.generateText
export const streamText = wrapped.streamText

export { Output } from 'ai'
export { createLangSmithProviderOptions } from 'langsmith/experimental/vercel'

export async function flushLangSmithTraces(): Promise<void> {
  await lsClient?.awaitPendingTraceBatches()
}
