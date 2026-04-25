'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import 'rrweb-player/dist/style.css'

/**
 * Renders a Browserbase rrweb session recording inline using the
 * `rrweb-player` Svelte component.
 *
 * Architecture: `rrweb-player` is a Svelte component that imperatively
 * mutates the DOM of its `target` element. React, in turn, owns its
 * own children's DOM. If we let both reconcile against the SAME node,
 * React eventually tries to remove a node Svelte has already replaced
 * (or vice versa) and explodes with `Failed to execute 'removeChild'`.
 *
 * The fix is to keep React's tree and Svelte's tree in separate DOM
 * subtrees:
 *   - One React-rendered overlay div for loading / error states.
 *   - One sibling `<div ref={mountRef} />` that React renders ONCE,
 *     never updates, and never adds children to. The Svelte player
 *     owns this node's contents exclusively.
 *
 * Why a thin imperative wrapper instead of `next/dynamic`:
 *   `rrweb-player` is a Svelte component, not a React component, so
 *   `next/dynamic` doesn't help — we need to instantiate it
 *   imperatively against a DOM target anyway. The dynamic
 *   `import('rrweb-player')` inside `useEffect` keeps the
 *   document-touching module out of the SSR bundle.
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
  className?: string
}

interface RrwebPlayerInstance {
  triggerResize?: () => void
  pause?: () => void
  $destroy?: () => void
}

export function RecordingPlayer({ recordingUrl, className }: RecordingPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let player: RrwebPlayerInstance | null = null
    let resizeObserver: ResizeObserver | null = null
    const target = mountRef.current

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
        const { default: rrwebPlayer } = await import('rrweb-player')
        if (cancelled) return

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
        }) as unknown as RrwebPlayerInstance

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
      // Tear down the Svelte component cleanly. `$destroy` removes the
      // nodes the Svelte component injected; we never touch React's
      // tree, so React's reconciler stays happy.
      try {
        player?.$destroy?.()
      } catch {
        // ignore
      }
    }
  }, [recordingUrl])

  return (
    <div className={`relative w-full bg-black ${className ?? ''}`}>
      {/*
        Svelte player mounts here. Critically, this div has NO React
        children — React renders it once and never reconciles its
        contents. The sibling overlays below are kept on a separate
        absolutely-positioned subtree so React can update them freely
        without touching this node.
      */}
      <div ref={mountRef} className="rrweb-player-mount min-h-[220px]" />

      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black">
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
      )}
    </div>
  )
}
