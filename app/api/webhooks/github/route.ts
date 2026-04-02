import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature, listInstallationRepos } from '@/lib/github'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import type { Json } from '@/lib/supabase/types'
import { normalizeGithubReposForStorage } from '@/lib/github-integration-config'

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
    .select('id, config')
    .eq('type', 'github')
    .eq('status', 'active')

  const matching = (integrations || []).filter((i) => {
    const config = i.config as Record<string, Json>
    return config.installation_id === installationId
  })

  if (matching.length === 0) return

  try {
    const repos = await listInstallationRepos(installationId)

    for (const integration of matching) {
      const config = integration.config as Record<string, Json>
      const currentSelected = (config.repos as Array<Record<string, Json>>) || []
      const accessibleNames = new Set(repos.map((r) => r.fullName))
      const filteredSelected = normalizeGithubReposForStorage(
        currentSelected.filter((r) => accessibleNames.has(r.full_name as string)),
      )

      const updatedConfig: Json = {
        ...config,
        // Never replace an explicit selection with the full installation list (multi-repo confuses the agent).
        repos: filteredSelected.length > 0 ? filteredSelected : [],
      }

      await supabase
        .from('integrations')
        .update({ config: updatedConfig, updated_at: new Date().toISOString() })
        .eq('id', integration.id)
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
    .select('id, config')
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
  }
}
