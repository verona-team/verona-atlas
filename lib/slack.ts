const SLACK_API_BASE = "https://slack.com/api"

export function getSlackRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
  return `${base}/api/integrations/slack/callback`
}

interface SlackOAuthAccessResponse {
  ok: boolean
  error?: string
  access_token?: string
  bot_user_id?: string
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
  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId) {
    throw new Error('SLACK_CLIENT_ID is not set')
  }

  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'channels:history,channels:read,chat:write,chat:write.public,users:read,team:read',
    user_scope: '',
    redirect_uri: getSlackRedirectUri(),
    state,
    response_type: 'code',
  })
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`
}

export async function exchangeCodeForToken(code: string): Promise<{
  botToken: string
  teamName: string
  teamId: string
  botUserId?: string
}> {
  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('SLACK_CLIENT_ID or SLACK_CLIENT_SECRET is not set')
  }

  const response = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: getSlackRedirectUri(),
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
    botUserId: data.bot_user_id,
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
