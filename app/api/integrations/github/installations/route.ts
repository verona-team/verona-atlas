import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getServerUser } from '@/lib/supabase/server-user'
import {
  listUserInstallations,
  refreshUserToken,
  type GitHubUserToken,
} from '@/lib/github'
import { encrypt, decrypt } from '@/lib/encryption'
import { chatServerLog } from '@/lib/chat/server-log'

/**
 * List the GitHub App installations the authenticated Verona user
 * can reach. Powered by the OAuth token persisted on
 * `user_github_identities` during the callback round trip.
 *
 * Used by the settings UI's installation picker, which shows up when
 * the OAuth callback found the user with more than one installation
 * (e.g. personal account + work org) and we can't guess which one
 * belongs to this Verona project.
 */
export async function GET() {
  const supabase = await createClient()
  const user = await getServerUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accessToken = await getUserAccessToken(user.id)
  if (!accessToken) {
    return NextResponse.json(
      { error: 'No GitHub identity on file; connect again.' },
      { status: 404 },
    )
  }

  try {
    const installations = await listUserInstallations(accessToken)
    return NextResponse.json({
      installations: installations.map((i) => ({
        id: i.id,
        account_login: i.accountLogin,
        account_type: i.accountType,
      })),
    })
  } catch (e) {
    chatServerLog('warn', 'github_list_installations_failed', {
      err: e,
      userId: user.id,
    })
    return NextResponse.json(
      { error: 'Failed to list GitHub installations' },
      { status: 500 },
    )
  }
}

/**
 * Fetch + refresh the caller's stored GitHub user access token.
 * Returns null if the user has no identity row yet or if we can't
 * produce a usable token (e.g. refresh failed, token can't be
 * decrypted).
 */
async function getUserAccessToken(userId: string): Promise<string | null> {
  const service = createServiceRoleClient()
  const { data: identity } = await service
    .from('user_github_identities')
    .select(
      'access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
    )
    .eq('user_id', userId)
    .maybeSingle()

  if (!identity) return null

  let accessToken: string
  try {
    accessToken = decrypt(identity.access_token_encrypted)
  } catch (e) {
    chatServerLog('warn', 'github_identity_decrypt_failed', { err: e, userId })
    return null
  }

  const expiresAt = identity.access_token_expires_at
    ? Date.parse(identity.access_token_expires_at)
    : null
  const needsRefresh = expiresAt !== null && Date.now() >= expiresAt - 60_000

  if (needsRefresh && identity.refresh_token_encrypted) {
    try {
      const refreshed: GitHubUserToken = await refreshUserToken(
        decrypt(identity.refresh_token_encrypted),
      )
      accessToken = refreshed.accessToken
      await service
        .from('user_github_identities')
        .update({
          access_token_encrypted: encrypt(refreshed.accessToken),
          refresh_token_encrypted: refreshed.refreshToken
            ? encrypt(refreshed.refreshToken)
            : identity.refresh_token_encrypted,
          access_token_expires_at: refreshed.accessTokenExpiresAt,
          refresh_token_expires_at:
            refreshed.refreshTokenExpiresAt ?? identity.refresh_token_expires_at,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
    } catch (e) {
      chatServerLog('warn', 'github_identity_token_refresh_failed', {
        err: e,
        userId,
      })
      return null
    }
  }

  return accessToken
}
