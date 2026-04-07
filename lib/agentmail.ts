import { AgentMailClient } from 'agentmail'

function getClient(): AgentMailClient {
  return new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  })
}

/**
 * Provision a dedicated AgentMail inbox for a project.
 * Used as the 2FA recovery email for test accounts.
 */
export async function createProjectInbox(projectSlug: string): Promise<{
  inboxId: string
  address: string
}> {
  const client = getClient()

  const inbox = await client.inboxes.create({
    username: `atlas-${projectSlug}-${Date.now()}`,
    displayName: `Atlas QA - ${projectSlug}`,
  })

  return {
    inboxId: inbox.inboxId,
    address: inbox.email,
  }
}

/**
 * Poll an AgentMail inbox for a 2FA verification code.
 * Returns the first numeric code (4-8 digits) found in recent messages.
 */
export async function poll2FACode(
  inboxId: string,
  since: Date,
  timeoutMs: number = 30000
): Promise<string> {
  const client = getClient()
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const response = await client.inboxes.messages.list(inboxId, {
      limit: 5,
    })

    const items = response?.messages
    if (items && Array.isArray(items)) {
      for (const item of items) {
        const msgDate = new Date(item.createdAt)
        if (msgDate < since) continue

        // MessageItem from list() lacks .text — fetch the full Message
        let text = item.subject || ''
        try {
          const full = await client.inboxes.messages.get(inboxId, item.messageId)
          text = full.text || full.extractedText || full.subject || full.preview || ''
        } catch {
          text = item.subject || item.preview || ''
        }

        const match = text.match(/\b(\d{4,8})\b/)
        if (match) {
          return match[1]
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error(`2FA code not received within ${timeoutMs}ms timeout`)
}
