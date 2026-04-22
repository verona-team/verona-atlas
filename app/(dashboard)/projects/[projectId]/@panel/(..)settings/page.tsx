import { SettingsPanel } from '@/components/dashboard/settings-panel'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function InterceptedSettingsPage({ params }: PageProps) {
  const { projectId } = await params
  return <SettingsPanel projectId={projectId} />
}
