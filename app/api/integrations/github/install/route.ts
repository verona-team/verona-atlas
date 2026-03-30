import { type NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const appSlug = process.env.GITHUB_APP_SLUG || 'atlas-qa'
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`)
  const projectId = request.nextUrl.searchParams.get('project_id')
  if (projectId) {
    url.searchParams.set('state', projectId)
  }
  return NextResponse.redirect(url)
}
