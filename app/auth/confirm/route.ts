import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PROJECTS_PATH = '/projects'

function safeNextPath(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return null
  }
  return next
}

/**
 * Handles the browser redirect after the user clicks the email confirmation link.
 * Supabase redirects here with ?code=... (PKCE) or ?token_hash=...&type=... (implicit).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = safeNextPath(searchParams.get('next')) ?? PROJECTS_PATH

  const cookieRedirect = NextResponse.redirect(new URL(next, origin))

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieRedirect.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return cookieRedirect
    }
    const login = new URL('/login', origin)
    login.searchParams.set('error', encodeURIComponent(error.message))
    return NextResponse.redirect(login)
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    })
    if (!error) {
      return cookieRedirect
    }
    const login = new URL('/login', origin)
    login.searchParams.set('error', encodeURIComponent(error.message))
    return NextResponse.redirect(login)
  }

  const login = new URL('/login', origin)
  login.searchParams.set(
    'error',
    encodeURIComponent('Missing confirmation parameters. Please use the link from your email.'),
  )
  return NextResponse.redirect(login)
}
