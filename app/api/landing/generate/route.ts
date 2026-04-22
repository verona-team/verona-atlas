import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { getRequesterLocation } from '@/lib/geo'

export const runtime = 'nodejs'
// Image generation can take a while; give the function plenty of room.
export const maxDuration = 300

const IMAGE_BUCKET = 'landing-images'
// Safety margin: the lock auto-releases after this long even if the request
// crashes or times out. Should be comfortably longer than a typical generation.
const LOCK_DURATION_SECONDS = 180
// 1 hour cooldown between successful generations, as specified.
const COOLDOWN_SECONDS = 60 * 60

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(1000),
})

export async function POST(request: Request) {
  let parsedBody: z.infer<typeof bodySchema>
  try {
    const json = await request.json()
    parsedBody = bodySchema.parse(json)
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400 }
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: 'Image generation is not configured.' },
      { status: 503 }
    )
  }

  const supabase = createServiceRoleClient()

  // Atomic lock acquisition. The Postgres function only returns a token if
  // the lock is currently free AND the cooldown window has elapsed, using a
  // single UPDATE...WHERE statement. If 100 requests hit at the same time,
  // exactly one of them wins the race; the rest receive NULL.
  const { data: token, error: lockError } = await supabase.rpc(
    'try_acquire_landing_lock',
    { p_lock_duration_seconds: LOCK_DURATION_SECONDS }
  )

  if (lockError) {
    console.error('[landing/generate] lock rpc error', lockError)
    return NextResponse.json(
      { error: 'Could not acquire generation lock.' },
      { status: 500 }
    )
  }

  if (!token) {
    const { data: lockRow } = await supabase
      .from('landing_generation_lock')
      .select('lock_expires_at, next_allowed_at')
      .eq('id', 1)
      .single()

    return NextResponse.json(
      {
        error:
          'Someone else is generating right now, or the hourly cooldown is active. Please wait.',
        lock_expires_at: lockRow?.lock_expires_at ?? null,
        next_allowed_at: lockRow?.next_allowed_at ?? null,
      },
      { status: 429 }
    )
  }

  try {
    const location = await getRequesterLocation()

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const result = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: parsedBody.prompt,
      size: '1024x1024',
      quality: 'low',
      n: 1,
    })

    const b64 = result.data?.[0]?.b64_json
    if (!b64) {
      throw new Error('Image API returned no data.')
    }

    const bytes = Buffer.from(b64, 'base64')

    const filename = `${Date.now()}-${crypto.randomUUID()}.png`
    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(filename, bytes, {
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      })

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`)
    }

    const { data: publicUrlData } = supabase.storage
      .from(IMAGE_BUCKET)
      .getPublicUrl(filename)

    const { data: inserted, error: insertError } = await supabase
      .from('landing_generated_images')
      .insert({
        name: parsedBody.name,
        prompt: parsedBody.prompt,
        location,
        image_url: publicUrlData.publicUrl,
      })
      .select('id, name, prompt, location, image_url, created_at')
      .single()

    if (insertError) {
      throw new Error(`Insert failed: ${insertError.message}`)
    }

    // Success — commit the cooldown window.
    const { error: commitError } = await supabase.rpc('commit_landing_lock', {
      p_token: token,
      p_cooldown_seconds: COOLDOWN_SECONDS,
    })
    if (commitError) {
      console.error('[landing/generate] commit error', commitError)
    }

    return NextResponse.json({ image: inserted })
  } catch (err) {
    console.error('[landing/generate] generation error', err)
    // Release the lock so the next user can immediately try again; don't set
    // a cooldown since we didn't actually produce an image.
    await supabase.rpc('release_landing_lock', { p_token: token })
    const message = err instanceof Error ? err.message : 'Generation failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
