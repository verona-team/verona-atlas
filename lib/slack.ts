const SLACK_API_BASE = "https://slack.com/api"

interface SlackOAuthAccessResponse {
  ok: boolean
  error?: string
  access_token?: string
  team?: { id?: string; name?: string }
}

interface SlackConversationsListResponse {
  ok: boolean
  error?: string
  channels?: Array<{ id: string; name: string }>
}

interface SlackPostMessageResponse {
  ok: boolean
  error?: string
}

export function buildOAuthURL(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!,
    scope: "chat:write,channels:read",
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`,
    state,
  })
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`
}

export async function exchangeCodeForToken(code: string): Promise<{
  botToken: string
  teamName: string
  teamId: string
}> {
  const response = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/integrations/slack/callback`,
    }),
  })

  const data = (await response.json()) as SlackOAuthAccessResponse
  if (!data.ok || !data.access_token) {
    throw new Error(`Slack OAuth error: ${data.error ?? "unknown"}`)
  }

  return {
    botToken: data.access_token,
    teamName: data.team?.name ?? "Unknown",
    teamId: data.team?.id ?? "",
  }
}

export async function listChannels(
  botToken: string,
): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(
    `${SLACK_API_BASE}/conversations.list?types=public_channel&limit=200`,
    {
      headers: { Authorization: `Bearer ${botToken}` },
    },
  )

  const data = (await response.json()) as SlackConversationsListResponse
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error ?? "unknown"}`)
  }

  return (data.channels ?? []).map((ch) => ({
    id: ch.id,
    name: ch.name,
  }))
}

export async function postMessage(
  botToken: string,
  channelId: string,
  blocks: object[],
  text: string = "Atlas Test Run Report",
): Promise<void> {
  const response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, blocks, text }),
  })

  const data = (await response.json()) as SlackPostMessageResponse
  if (!data.ok) {
    throw new Error(`Slack postMessage error: ${data.error ?? "unknown"}`)
  }
}

export interface TestRunReport {
  projectName: string
  runId: string
  status: string
  totalTests: number
  passed: number
  failed: number
  errors: number
  skipped: number
  duration: string
  failedTests: Array<{ name: string; error: string }>
  summary: string
  dashboardUrl: string
}

export function formatTestRunBlocks(report: TestRunReport): object[] {
  const statusEmoji = report.failed > 0 || report.errors > 0 ? "⚠️" : "✅"
  const statusText =
    report.failed > 0 || report.errors > 0 ? "Failures Detected" : "All Passed"

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${statusEmoji} Atlas Test Run — ${report.projectName}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Status:* ${statusText}\n*Duration:* ${report.duration}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Passed:* ${report.passed}` },
        { type: "mrkdwn", text: `*Failed:* ${report.failed}` },
        { type: "mrkdwn", text: `*Errors:* ${report.errors}` },
        { type: "mrkdwn", text: `*Skipped:* ${report.skipped}` },
      ],
    },
  ]

  if (report.failedTests.length > 0) {
    blocks.push({ type: "divider" })
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Failed Tests:*\n" +
          report.failedTests.map((t) => `• *${t.name}*: ${t.error}`).join("\n"),
      },
    })
  }

  if (report.summary) {
    blocks.push({ type: "divider" })
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*AI Analysis:*\n${report.summary}` },
    })
  }

  blocks.push({ type: "divider" })
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `<${report.dashboardUrl}|View full report in Atlas →>`,
    },
  })

  return blocks
}
