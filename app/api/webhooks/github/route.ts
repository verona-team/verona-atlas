import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature, listInstallationRepos } from '@/lib/github'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import type { Json } from '@/lib/supabase/types'
import {
  githubRepoToJson,
  parseGithubLinkedRepo,
} from '@/lib/github-integration-config'
import { clearResearchReportsForProject } from '@/lib/github-integration-guard'

export async function POST(request: NextRequest) {
  const body = await request.text()
  const signature = request.headers.get('x-hub-signature-256') || ''

  if (!verifyWebhookSignature(body, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = request.headers.get('x-github-event')
  const payload = JSON.parse(body)

  if (event === 'installation_repositories') {
    await handleInstallationRepositories(payload)
  } else if (event === 'installation' && payload.action === 'deleted') {
    await handleInstallationDeleted(payload)
  }

  return NextResponse.json({ ok: true })
}

async function handleInstallationRepositories(payload: {
  installation: { id: number }
  action: string
}) {
  const installationId = payload.installation.id
  const supabase = createServiceRoleClient()

  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, project_id, config')
    .eq('type', 'github')
    .eq('status', 'active')

  const matching = (integrations || []).filter((i) => {
    const config = i.config as Record<string, Json>
    return config.installation_id === installationId
  })

  if (matching.length === 0) return

  try {
    const installationRepos = await listInstallationRepos(installationId)
    const accessibleNames = new Set(installationRepos.map((r) => r.fullName))

    for (const integration of matching) {
      const projectId = integration.project_id as string
      const config = integration.config as Record<string, Json>
      const linked = parseGithubLinkedRepo(config)

      if (!linked) {
        continue
      }

      let updatedConfig: Json
      if (!accessibleNames.has(linked.full_name)) {
        updatedConfig = { ...config, repo: null }
      } else {
        const fresh = installationRepos.find((r) => r.fullName === linked.full_name)
        if (!fresh) {
          updatedConfig = { ...config, repo: null }
        } else {
          updatedConfig = {
            ...config,
            repo: githubRepoToJson({
              full_name: fresh.fullName,
              private: fresh.private,
              default_branch: fresh.defaultBranch,
            }),
          }
        }
      }

      await supabase
        .from('integrations')
        .update({ config: updatedConfig, updated_at: new Date().toISOString() })
        .eq('id', integration.id)

      await clearResearchReportsForProject(supabase, projectId)
    }
  } catch (e) {
    console.error('Failed to sync repos after webhook:', e)
  }
}

async function handleInstallationDeleted(payload: {
  installation: { id: number }
}) {
  const installationId = payload.installation.id
  const supabase = createServiceRoleClient()

  const { data: integrations } = await supabase
    .from('integrations')
    .select('id, project_id, config')
    .eq('type', 'github')
    .eq('status', 'active')

  const matching = (integrations || []).filter((i) => {
    const config = i.config as Record<string, Json>
    return config.installation_id === installationId
  })

  for (const integration of matching) {
    await supabase
      .from('integrations')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', integration.id)

    await clearResearchReportsForProject(supabase, integration.project_id as string)
  }
}
