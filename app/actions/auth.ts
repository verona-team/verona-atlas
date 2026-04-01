'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

export async function signUp(formData: FormData) {
  const supabase = await createClient()

  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const orgName = formData.get('orgName') as string

  if (!email || !password || !orgName) {
    return { error: 'All fields are required' }
  }

  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
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

  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  const { data: org, error: orgError } = await adminClient
    .from('organizations')
    .insert({
      name: orgName,
      slug,
      created_by: authData.user.id,
    })
    .select()
    .single()

  if (orgError) {
    return { error: `Failed to create organization: ${orgError.message}` }
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

  redirect('/projects')
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
