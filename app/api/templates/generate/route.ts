import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'
import { generateTemplates } from '@/lib/test-planner'
import { fetchRecentCommits } from '@/lib/github'
import { fetchSessionRecordings, fetchErrorEvents, fetchTopPages } from '@/lib/posthog'
import { decrypt } from '@/lib/encryption'
import type { Json } from '@/lib/supabase/types'

const GenerateSchema = z.object({
  projectId: z.string().uuid(),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const parsed = GenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { projectId } = parsed.data

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) {
    return NextResponse.json({ error: 'No organization found' }, { status: 404 })
  }

  const { data: project } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: integrations } = await supabase
    .from('integrations')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'active')

  const githubIntegration = integrations?.find((i) => i.type === 'github')
  const posthogIntegration = integrations?.find((i) => i.type === 'posthog')

  let commits: Array<{ sha: string; message: string; date: string; author: string }> = []
  if (githubIntegration) {
    try {
      const config = githubIntegration.config as Record<string, Json>
      const installationId = config.installation_id as number
      const repos = (config.repos as Array<Record<string, Json>>) || []
      if (installationId && repos.length > 0) {
        for (const repo of repos.slice(0, 3)) {
          const repoName = repo.full_name as string
          if (repoName) {
            const repoCommits = await fetchRecentCommits(installationId, repoName)
            commits.push(...repoCommits)
          }
        }
      }
    } catch (e) {
      console.warn('Failed to fetch GitHub commits:', e)
    }
  }

  let sessionRecordings: unknown[] = []
  let errorEvents: unknown[] = []
  let topPages: unknown[] = []
  if (posthogIntegration) {
    try {
      const config = posthogIntegration.config as Record<string, Json>
      const apiKeyEncrypted = config.api_key_encrypted as string
      const posthogProjectId = config.posthog_project_id as string
      if (apiKeyEncrypted && posthogProjectId) {
        const apiKey = decrypt(apiKeyEncrypted)
        const phConfig = { apiKey, projectId: posthogProjectId }
        ;[sessionRecordings, errorEvents, topPages] = await Promise.all([
          fetchSessionRecordings(phConfig).catch(() => []),
          fetchErrorEvents(phConfig).catch(() => []),
          fetchTopPages(phConfig).catch(() => []),
        ])
      }
    } catch (e) {
      console.warn('Failed to fetch PostHog data:', e)
    }
  }

  const { data: existingTemplates } = await supabase
    .from('test_templates')
    .select('name, description')
    .eq('project_id', projectId)

  try {
    const generated = await generateTemplates({
      appUrl: project.app_url,
      commits,
      sessionRecordings,
      errorEvents,
      topPages,
      existingTemplates: (existingTemplates ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      })),
    })

    return NextResponse.json(generated)
  } catch (e) {
    console.error('AI template generation failed:', e)
    return NextResponse.json(
      { error: 'Failed to generate templates' },
      { status: 500 },
    )
  }
}
