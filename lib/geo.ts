import { headers } from 'next/headers'

/**
 * Best-effort derivation of the requester's approximate location from
 * request headers. On Vercel, the platform injects `x-vercel-ip-city`,
 * `x-vercel-ip-country-region`, and `x-vercel-ip-country` automatically.
 * We gracefully fall back to "somewhere on Earth" if none are present
 * (e.g. during local dev, where we try ipapi.co as a fallback).
 */
export async function getRequesterLocation(): Promise<string> {
  const h = await headers()

  const city = h.get('x-vercel-ip-city')
  const region = h.get('x-vercel-ip-country-region')
  const country = h.get('x-vercel-ip-country')

  if (city || country) {
    const parts: string[] = []
    if (city) parts.push(decodeURIComponent(city))
    if (country === 'US' && region) parts.push(region)
    else if (country) parts.push(country)
    return parts.join(', ') || 'somewhere on Earth'
  }

  // Local-dev fallback: look up via ipapi.co using the forwarded IP.
  const forwarded = h.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim()
  if (ip && ip !== '127.0.0.1' && ip !== '::1') {
    try {
      const res = await fetch(`https://ipapi.co/${ip}/json/`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const data = (await res.json()) as {
          city?: string
          region?: string
          country_name?: string
          country_code?: string
        }
        const parts: string[] = []
        if (data.city) parts.push(data.city)
        if (data.country_code === 'US' && data.region) parts.push(data.region)
        else if (data.country_name) parts.push(data.country_name)
        if (parts.length > 0) return parts.join(', ')
      }
    } catch {
      // Fall through.
    }
  }

  return 'somewhere on Earth'
}
