import { Sandbox } from '@vercel/sandbox'
import { INTEGRATION_REGISTRY } from '@/lib/integrations/registry'
import type { IntegrationCredentials } from './types'

export async function createResearchSandbox(
  integrations: IntegrationCredentials[],
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
    timeout: 900_000,
    networkPolicy: Object.keys(allowRules).length > 0
      ? { allow: allowRules }
      : 'deny-all',
  })

  return sandbox
}

export async function executeInSandbox(
  sandbox: Sandbox,
  code: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await sandbox.writeFiles([{
    path: 'script.mjs',
    content: Buffer.from(code),
  }])

  const result = await sandbox.runCommand('node', ['script.mjs'])

  const stdout = await result.stdout()
  const stderr = await result.stderr()

  return {
    stdout: stdout.slice(0, 50000),
    stderr: stderr.slice(0, 10000),
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
