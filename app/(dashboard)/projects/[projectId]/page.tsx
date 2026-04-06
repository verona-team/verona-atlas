import { redirect } from 'next/navigation'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectPage({ params }: PageProps) {
  const { projectId } = await params
  redirect(`/projects/${projectId}/chat`)
}
