import type { User, SupabaseClient } from '@supabase/supabase-js'

const RETRY_BACKOFF_MS = [0, 80, 200, 500]

function isTransientAuthTransportError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const msg = String(err.message).toLowerCase()
    if (msg.includes('fetch') || msg.includes('network')) return true
  }
  const cause =
    err && typeof err === 'object' && 'cause' in err
      ? (err as { cause?: unknown }).cause
      : undefined
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = String((cause as { code?: string }).code)
    if (
      ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET'].includes(
        code,
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Resolve the current user on the server in a way that survives transient
 * failures talking to Supabase Auth (e.g. ECONNRESET on `getUser()`'s HTTP
 * validation request). Retries a few times, then falls back to the session
 * from cookies (same process as `getSession()`, no extra round trip when it
 * succeeds).
 */
export async function getServerUser(supabase: SupabaseClient): Promise<User | null> {
  let lastFailure: unknown

  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]))
    }
    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser()

      if (!error && user) {
        return user
      }
      if (!error && !user) {
        return null
      }

      if (error && isTransientAuthTransportError(error)) {
        lastFailure = error
        continue
      }

      return null
    } catch (err) {
      if (isTransientAuthTransportError(err)) {
        lastFailure = err
        continue
      }
      throw err
    }
  }

  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (session?.user) {
      console.warn(
        'getServerUser: using session fallback after auth transport failures',
        lastFailure,
      )
      return session.user
    }
  } catch (err) {
    console.error('getServerUser: getSession fallback failed', err, lastFailure)
    return null
  }

  console.error('getServerUser: exhausted retries and session fallback', lastFailure)
  return null
}
