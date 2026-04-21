/**
 * Canonical site origin for server-side redirects (e.g. Supabase emailRedirectTo).
 * Prefer NEXT_PUBLIC_APP_URL; fall back to Vercel preview URL in deployments.
 */
export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (explicit) {
    return explicit.replace(/\/$/, '')
  }

  const vercel = process.env.VERCEL_URL?.trim()
  if (vercel) {
    const host = vercel.startsWith('http') ? vercel : `https://${vercel}`
    return host.replace(/\/$/, '')
  }

  throw new Error(
    'Set NEXT_PUBLIC_APP_URL (or deploy on Vercel with VERCEL_URL) for email confirmation redirects.',
  )
}
