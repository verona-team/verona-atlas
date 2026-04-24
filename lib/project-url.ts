/**
 * Normalize a user-supplied project app URL.
 *
 * Accepts URLs with or without a scheme / `www.` prefix. Bare domains such
 * as `veronaresearch.com` or `www.veronaresearch.com` are upgraded to
 * `https://…` so they become valid URLs. Anything that cannot be parsed as
 * an `http(s)` URL with a dotted hostname returns `null`.
 *
 * Returns the normalized URL string, or `null` if the input is not a
 * recognizable web URL.
 */
export function normalizeProjectUrl(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // RFC 3986-ish scheme check — any letter-led token followed by `://`
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  // Require a real domain — `localhost`, bare hostnames, and IPs-without-dots
  // are not useful for an app URL that the agent will actually browse.
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return null
  }

  return candidate
}
