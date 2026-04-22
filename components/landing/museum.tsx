'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'

type GalleryImage = {
  id: string
  name: string
  prompt: string
  location: string | null
  image_url: string
  created_at: string
}

type LockState = {
  lock_expires_at: string | null
  next_allowed_at: string | null
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'ready'
  const totalSeconds = Math.ceil(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function Museum() {
  const [images, setImages] = useState<GalleryImage[]>([])
  const [lock, setLock] = useState<LockState>({
    lock_expires_at: null,
    next_allowed_at: null,
  })
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [loadedOnce, setLoadedOnce] = useState(false)

  const pollRef = useRef<NodeJS.Timeout | null>(null)

  const loadGallery = useCallback(async () => {
    try {
      const res = await fetch('/api/landing/gallery', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as {
        images: GalleryImage[]
        lock: LockState
      }
      setImages(data.images)
      setLock(data.lock)
      setLoadedOnce(true)
    } catch {
      // Silently ignore fetch errors on the landing page.
    }
  }, [])

  useEffect(() => {
    loadGallery()
  }, [loadGallery])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  // Poll more frequently while a generation is in flight so the new image
  // pops in without a manual refresh.
  useEffect(() => {
    const lockUntil = lock.lock_expires_at
      ? new Date(lock.lock_expires_at).getTime()
      : 0
    const inFlight = lockUntil > now
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(loadGallery, inFlight ? 3000 : 20000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [lock, now, loadGallery])

  const nextAllowedMs = lock.next_allowed_at
    ? new Date(lock.next_allowed_at).getTime()
    : 0
  const lockUntilMs = lock.lock_expires_at
    ? new Date(lock.lock_expires_at).getTime()
    : 0

  const someoneGenerating = lockUntilMs > now
  const cooldownActive = nextAllowedMs > now
  const canSubmit = !someoneGenerating && !cooldownActive && !submitting

  const statusLine = useMemo(() => {
    if (submitting) return 'Generating your image…'
    if (someoneGenerating) {
      return `Someone is generating right now — try again in ${formatCountdown(lockUntilMs - now)}`
    }
    if (cooldownActive) {
      return `Next generation unlocks in ${formatCountdown(nextAllowedMs - now)}`
    }
    return 'Ready — the next prompt is yours.'
  }, [submitting, someoneGenerating, cooldownActive, lockUntilMs, nextAllowedMs, now])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    if (!name.trim() || !prompt.trim()) {
      toast.error('Please enter your name and a prompt.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/landing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim() }),
      })
      const data = (await res.json()) as {
        image?: GalleryImage
        error?: string
        lock_expires_at?: string | null
        next_allowed_at?: string | null
      }
      if (!res.ok) {
        if (res.status === 429) {
          setLock({
            lock_expires_at: data.lock_expires_at ?? lock.lock_expires_at,
            next_allowed_at: data.next_allowed_at ?? lock.next_allowed_at,
          })
        }
        toast.error(data.error ?? 'Generation failed.')
        return
      }
      toast.success('Added to the museum.')
      setPrompt('')
      await loadGallery()
    } catch (err) {
      console.error(err)
      toast.error('Generation failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      id="museum"
      className="w-full max-w-6xl py-24 sm:py-32 flex flex-col items-center gap-12"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="text-[13px] uppercase tracking-[0.2em] text-[#1a1a1a]/50 font-medium">
          The Museum
        </span>
        <h2 className="text-3xl sm:text-4xl font-normal tracking-tight text-[#1a1a1a] max-w-xl">
          A communal wall of images made by people on this page.
        </h2>
        <p className="text-[15px] text-[#1a1a1a]/60 max-w-lg">
          One generation per hour, globally. Whoever gets in first sets the
          clock for everyone else.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xl flex flex-col gap-3 rounded-2xl border border-[#1a1a1a]/10 bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
      >
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="museum-name"
            className="text-[13px] font-medium text-[#1a1a1a]/80"
          >
            Your name
          </label>
          <Input
            id="museum-name"
            placeholder="Jeff"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canSubmit && !submitting ? true : submitting}
            maxLength={80}
            autoComplete="given-name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="museum-prompt"
            className="text-[13px] font-medium text-[#1a1a1a]/80"
          >
            Your prompt
          </label>
          <Textarea
            id="museum-prompt"
            placeholder="a neon koi swimming through a ramen bowl, studio ghibli style"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canSubmit && !submitting ? true : submitting}
            maxLength={1000}
            rows={3}
          />
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <span
            className={`text-[13px] ${
              someoneGenerating || cooldownActive
                ? 'text-[#1a1a1a]/50'
                : 'text-emerald-600'
            }`}
            aria-live="polite"
          >
            {statusLine}
          </span>
          <Button
            type="submit"
            disabled={!canSubmit || !name.trim() || !prompt.trim()}
          >
            {submitting
              ? 'Generating…'
              : someoneGenerating
                ? `Locked ${formatCountdown(lockUntilMs - now)}`
                : cooldownActive
                  ? `Unlocks in ${formatCountdown(nextAllowedMs - now)}`
                  : 'Generate'}
          </Button>
        </div>
      </form>

      <div className="w-full">
        {!loadedOnce ? (
          <div className="text-center text-[15px] text-[#1a1a1a]/40">
            Loading the museum…
          </div>
        ) : images.length === 0 ? (
          <div className="text-center text-[15px] text-[#1a1a1a]/40">
            The walls are blank. Be the first to hang something.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((img) => (
              <figure key={img.id} className="flex flex-col gap-3">
                <div className="overflow-hidden rounded-xl border border-[#1a1a1a]/10 bg-[#1a1a1a]/[0.02]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.image_url}
                    alt={img.prompt}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <figcaption className="text-[13px] leading-relaxed text-[#1a1a1a]/70">
                  <span className="font-medium text-[#1a1a1a]">{img.name}</span>{' '}
                  from{' '}
                  <span className="text-[#1a1a1a]">
                    {img.location ?? 'somewhere on Earth'}
                  </span>{' '}
                  requested{' '}
                  <span className="italic text-[#1a1a1a]">
                    &ldquo;{img.prompt}&rdquo;
                  </span>{' '}
                  <span className="text-[#1a1a1a]/40">
                    · {formatWhen(img.created_at)}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
