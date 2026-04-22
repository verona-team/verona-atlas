import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServiceRoleClient()

  const [imagesRes, lockRes] = await Promise.all([
    supabase
      .from('landing_generated_images')
      .select('id, name, prompt, location, image_url, created_at')
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('landing_generation_lock')
      .select('lock_expires_at, next_allowed_at')
      .eq('id', 1)
      .single(),
  ])

  if (imagesRes.error) {
    console.error('[landing/gallery] images error', imagesRes.error)
    return NextResponse.json(
      { error: 'Could not load gallery.' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    images: imagesRes.data ?? [],
    lock: {
      lock_expires_at: lockRes.data?.lock_expires_at ?? null,
      next_allowed_at: lockRes.data?.next_allowed_at ?? null,
    },
  })
}
