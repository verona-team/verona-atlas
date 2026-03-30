import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft } from 'lucide-react'

type PageProps = { params: Promise<{ projectId: string }> }

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { projectId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: membership } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', user.id)
    .limit(1)
    .single()

  if (!membership) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('org_id', membership.org_id)
    .single()

  if (!project) notFound()

  const { data: integrations } = await supabase
    .from('integrations')
    .select('type, status')
    .eq('project_id', projectId)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Link href={`/projects/${project.id}`}>
          <Button variant="ghost" size="sm" className="w-fit -ml-2">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to project
          </Button>
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Project settings</h1>
        <p className="text-muted-foreground">{project.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
          <CardDescription>
            Connect GitHub, PostHog, and Slack from the API routes; status is shown here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {integrations && integrations.length > 0 ? (
              integrations.map((row) => (
                <li key={row.type} className="flex justify-between rounded-md border px-3 py-2">
                  <span className="font-medium capitalize">{row.type}</span>
                  <span className="text-muted-foreground">{row.status}</span>
                </li>
              ))
            ) : (
              <li className="text-muted-foreground">No integrations connected yet.</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
