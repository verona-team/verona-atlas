'use server'

import { randomBytes } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getSiteUrl } from '@/lib/app-url'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

function slugifyOrgName(orgName: string): string {
  return orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function randomSlugSuffix(): string {
  return randomBytes(4).toString('hex')
}

// Inserts an organization, disambiguating the slug if it collides with an
// existing row. Org names are allowed to duplicate; slugs stay unique by
// appending `-2`, `-3`, ... and falling back to a random suffix after that.
async function createOrganizationWithUniqueSlug(
  adminClient: SupabaseClient<Database>,
  orgName: string,
  userId: string,
) {
  const baseSlug = slugifyOrgName(orgName) || `org-${randomSlugSuffix()}`
  const MAX_NUMERIC_ATTEMPTS = 50

  for (let attempt = 0; attempt < MAX_NUMERIC_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`

    const { data, error } = await adminClient
      .from('organizations')
      .insert({ name: orgName, slug, created_by: userId })
      .select()
      .single()

    if (!error) return { data, error: null as null }

    const isSlugCollision =
      error.code === '23505' && /organizations_slug_key|slug/i.test(error.message)
    if (!isSlugCollision) return { data: null, error }
  }

  // Extremely unlikely fallback: numeric suffixes all taken. Use a random
  // suffix which is effectively collision-free.
  const slug = `${baseSlug}-${randomSlugSuffix()}`
  return await adminClient
    .from('organizations')
    .insert({ name: orgName, slug, created_by: userId })
    .select()
    .single()
}

export async function signUp(formData: FormData) {
  const supabase = await createClient()

  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const orgName = formData.get('orgName') as string

  if (!email || !password || !orgName) {
    return { error: 'All fields are required' }
  }

  const emailRedirectTo = `${getSiteUrl()}/auth/confirm`

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo,
    },
  })

  if (authError) {
    return { error: authError.message }
  }

  if (!authData.user) {
    return { error: 'Failed to create user' }
  }

  // Use the service role client to create the org and membership.
  // After signUp, the user may not have an active session yet (e.g. email
  // confirmation enabled), so the anon-key client would fail RLS checks.
  // The service role bypasses RLS and is safe here because we already
  // verified the user was created above.
  const adminClient = createServiceRoleClient()

  const { data: org, error: orgError } = await createOrganizationWithUniqueSlug(
    adminClient,
    orgName,
    authData.user.id,
  )

  if (orgError || !org) {
    return {
      error: `Failed to create organization: ${orgError?.message ?? 'unknown error'}`,
    }
  }

  const { error: memberError } = await adminClient
    .from('org_members')
    .insert({
      org_id: org.id,
      user_id: authData.user.id,
      role: 'owner',
    })

  if (memberError) {
    return { error: `Failed to set up membership: ${memberError.message}` }
  }

  return { success: true, email }
}

export async function signIn(formData: FormData) {
  const supabase = await createClient()

  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    return { error: 'Email and password are required' }
  }

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return { error: error.message }
  }

  redirect('/projects')
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
