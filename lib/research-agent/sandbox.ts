import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { INTEGRATION_REGISTRY } from '@/lib/integrations/registry'
import type { IntegrationCredentials } from './types'

export async function createResearchSandbox(
  integrations: IntegrationCredentials[],
  env?: Record<string, string>,
): Promise<Sandbox> {
  const allowRules: Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>> = {}

  for (const integration of integrations) {
    const spec = INTEGRATION_REGISTRY[integration.type]
    if (!spec) continue

    const headers = spec.buildAuthHeaders(integration.credentials)
    Object.assign(allowRules, headers)
  }

  const sandbox = await Sandbox.create({
    runtime: 'node24',
    timeout: 800_000,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    networkPolicy: Object.keys(allowRules).length > 0
      ? { allow: allowRules }
      : 'deny-all',
  })

  return sandbox
}

export async function executeInSandbox(
  sandbox: Sandbox,
  code: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scriptName = `script_${randomUUID().replace(/-/g, '').slice(0, 12)}.mjs`

  await sandbox.writeFiles([{
    path: scriptName,
    content: Buffer.from(code),
  }])

  const result =
    env && Object.keys(env).length > 0
      ? await sandbox.runCommand({ cmd: 'node', args: [scriptName], env })
      : await sandbox.runCommand('node', [scriptName])

  const stdout = await result.stdout()
  const stderr = await result.stderr()

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
  }
}

export async function teardownSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.stop()
  } catch {
    // already stopped
  }
}
