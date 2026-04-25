'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import 'rrweb-player/dist/style.css'

/**
 * Renders a Browserbase rrweb session recording inline using the
 * `rrweb-player` Svelte component.
 *
 * Why a thin imperative wrapper instead of `next/dynamic`:
 *   - `rrweb-player` is a Svelte component, not a React component, so
 *     `next/dynamic` doesn't help — we need to instantiate it imperatively
 *     against a DOM target anyway.
 *   - `rrweb-player` touches `document` and constructs a Svelte component
 *     at module-init time, so the import has to be deferred until after
 *     mount on the client. We do that with a top-level dynamic `import()`
 *     inside `useEffect`.
 *
 * Recording payload shape: `runner/recordings.py` stores the Browserbase
 * `/v1/sessions/{id}/recording` response verbatim, which is an array of
 * `SessionRecording` objects: `{ data, sessionId, timestamp, type }`.
 * `rrweb-player` expects `eventWithTime` (`{ data, timestamp, type }`),
 * so we strip `sessionId` before handing them off.
 */

interface RawRecordingEvent {
  data: unknown
  sessionId?: string
  timestamp: number
  type: number
}

interface RrwebEvent {
  data: unknown
  timestamp: number
  type: number
}

interface RecordingPlayerProps {
  recordingUrl: string
  /**
   * Optional class name applied to the player container. The player
   * sizes itself to the container's width via `triggerResize()`.
   */
  className?: string
}

export function RecordingPlayer({ recordingUrl, className }: RecordingPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let player: { triggerResize?: () => void; pause?: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null
    // Capture the current ref so the cleanup function uses the same DOM
    // node we instantiated against (the lint rule below would otherwise
    // warn that the ref may have moved by cleanup time).
    const target = containerRef.current

    async function init() {
      if (!target) return

      setStatus('loading')
      setErrorMessage(null)

      let events: RrwebEvent[]
      try {
        const res = await fetch(recordingUrl, { cache: 'force-cache' })
        if (!res.ok) {
          throw new Error(`Failed to fetch recording (${res.status})`)
        }
        const raw = (await res.json()) as RawRecordingEvent[]
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error('Recording is empty')
        }
        events = raw.map(({ data, timestamp, type }) => ({ data, timestamp, type }))
        if (events.length < 2) {
          // rrweb-player requires at least 2 events to compute meta
          // and render the timeline.
          throw new Error('Recording has too few events to replay')
        }
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to load recording'
        setStatus('error')
        setErrorMessage(msg)
        return
      }

      if (cancelled) return

      try {
        // Dynamic import keeps the Svelte/DOM-touching player out of the
        // SSR bundle and the module-eval path until after mount. The
        // stylesheet is imported statically at the top of this module so
        // Next.js bundles it once for any page that pulls in the player.
        const { default: rrwebPlayer } = await import('rrweb-player')
        if (cancelled) return

        // Clear any prior render (e.g. from a recordingUrl change).
        target.innerHTML = ''

        const measuredWidth = Math.max(320, target.clientWidth || 720)
        const measuredHeight = Math.round(measuredWidth * (9 / 16))

        player = new rrwebPlayer({
          target,
          props: {
            events: events as never,
            width: measuredWidth,
            height: measuredHeight,
            autoPlay: false,
            showController: true,
            skipInactive: true,
            speedOption: [1, 2, 4, 8],
          },
        })

        // Keep the embedded player sized to the card it lives in.
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            try {
              player?.triggerResize?.()
            } catch {
              // ignore
            }
          })
          resizeObserver.observe(target)
        }

        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to render recording'
        setStatus('error')
        setErrorMessage(msg)
      }
    }

    void init()

    return () => {
      cancelled = true
      try {
        resizeObserver?.disconnect()
      } catch {
        // ignore
      }
      try {
        player?.pause?.()
      } catch {
        // ignore
      }
      if (target) {
        target.innerHTML = ''
      }
    }
  }, [recordingUrl])

  return (
    <div className={className}>
      <div
        ref={containerRef}
        className="rrweb-player-host relative flex min-h-[220px] w-full items-center justify-center overflow-hidden bg-black"
      >
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-xs text-white/70">
            <Loader2 className="size-3.5 animate-spin" />
            Loading recording…
          </div>
        )}
        {status === 'error' && (
          <div className="flex items-center gap-2 px-4 py-6 text-center text-xs text-white/70">
            <AlertCircle className="size-3.5 text-amber-400" />
            {errorMessage ?? 'Recording unavailable'}
          </div>
        )}
      </div>
    </div>
  )
}
