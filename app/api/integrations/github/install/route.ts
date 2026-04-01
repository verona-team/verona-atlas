import { type NextRequest, NextResponse } from 'next/server'
import { getAppSlug } from '@/lib/github'

export async function GET(request: NextRequest) {
  const slug = await getAppSlug()
  const url = new URL(`https://github.com/apps/${slug}/installations/new`)
  const projectId = request.nextUrl.searchParams.get('project_id')
  const returnTo = request.nextUrl.searchParams.get('return_to')
  if (projectId) {
    const state = returnTo ? `${projectId}::${returnTo}` : projectId
    url.searchParams.set('state', state)
  }
  return NextResponse.redirect(url)
}
