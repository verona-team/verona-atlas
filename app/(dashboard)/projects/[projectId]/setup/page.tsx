import { redirect } from 'next/navigation'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectSetupPage({ params }: PageProps) {
  const { projectId } = await params
  redirect(`/projects/${projectId}`)
}
