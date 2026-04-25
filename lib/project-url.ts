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
  // Require a real domain. A trailing `.` (e.g. `langchain.`) and bare
  // hostnames like `localhost` or `myhost` shouldn't qualify — we want a
  // hostname with at least two non-empty labels and a recognizable
  // alphabetic TLD of at least two characters.
  const hostname = parsed.hostname
  if (!hostname) return null
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) return null
  const tld = labels[labels.length - 1]
  if (!/^[a-z]{2,}$/i.test(tld)) return null
  // Reject a trailing dot (`example.com.` or `langchain.`) — `URL`
  // happily preserves it but it never indicates a usable web origin
  // for our purposes.
  if (hostname.endsWith('.')) return null

  return candidate
}
