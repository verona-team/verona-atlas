import { redirect } from 'next/navigation'

type PageProps = {
  params: Promise<{ projectId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Settings is rendered as an overlay over the chat, not its own page, so that
 * the chat stays mounted. We keep this route for backwards compatibility with
 * OAuth callbacks and deep links: redirect to the chat with a query flag that
 * the chat page will consume to open the overlay.
 */
export default async function ProjectSettingsPage({ params, searchParams }: PageProps) {
  const { projectId } = await params
  const sp = await searchParams
  const query = new URLSearchParams()
  query.set('settings', '1')
  for (const [key, value] of Object.entries(sp)) {
    if (key === 'settings') continue
    if (typeof value === 'string') query.set(key, value)
    else if (Array.isArray(value)) value.forEach((v) => query.append(key, v))
  }
  redirect(`/projects/${projectId}/chat?${query.toString()}`)
}
