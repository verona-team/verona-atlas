/**
 * Helpers for stashing the URL a visitor entered on the landing page so the
 * authenticated dashboard can prefill the "New project" modal once they
 * sign up and land on `/projects`.
 */

import { normalizeProjectUrl } from './project-url'

export const PENDING_PROJECT_URL_KEY = 'verona-pending-project-url'

export function savePendingProjectUrl(url: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PENDING_PROJECT_URL_KEY, url)
  } catch {
    /* ignore — private mode / disabled storage */
  }
}

export function readPendingProjectUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(PENDING_PROJECT_URL_KEY)
  } catch {
    return null
  }
}

export function clearPendingProjectUrl(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PENDING_PROJECT_URL_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Derive a sensible default project name from a URL. Strips the protocol,
 * any leading `www.`, and the trailing TLD segment (e.g. `.com`, `.io`,
 * `.co.uk` → drops only the last TLD; subdomain chains like `app.example`
 * are preserved).
 *
 *   https://www.veronaresearch.com/  -> veronaresearch
 *   app.example.com                  -> app.example
 *   foo.bar.co.uk                    -> foo.bar.co
 */
export function deriveProjectNameFromUrl(url: string): string {
  const normalized = normalizeProjectUrl(url)
  if (!normalized) return ''
  let host: string
  try {
    host = new URL(normalized).hostname
  } catch {
    return ''
  }
  host = host.replace(/^www\./i, '')
  host = host.replace(/\.[a-z]{2,}$/i, '')
  return host
}
