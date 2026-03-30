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
    const messages = await client.inboxes.messages.list(inboxId, {
      limit: 5,
    })

    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        // Check if message is recent enough
        const msgDate = new Date(msg.createdAt)
        if (msgDate < since) continue

        // Look for OTP code in the message text
        const text = msg.text || msg.subject || ''
        const match = text.match(/\b(\d{4,8})\b/)
        if (match) {
          return match[1]
        }
      }
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  throw new Error(`2FA code not received within ${timeoutMs}ms timeout`)
}
