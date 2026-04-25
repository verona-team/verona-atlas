'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2, Pause, Play } from 'lucide-react'
import 'rrweb-player/dist/style.css'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ExpandableContainer } from './expandable-frame'

/**
 * Renders a session recording inline using `rrweb-player` under the hood,
 * but with rrweb's built-in controller hidden in favor of a custom React
 * UI: a centered overlay play/pause button, a top-right speed dropdown,
 * and a thin progress + elapsed-time row pinned below the frame. The
 * underlying Svelte component still owns playback (DOM mutation
 * scheduling, skip-inactive gap detection); we just drive it
 * imperatively via `play()` / `pause()` / `setSpeed()` / `goto()`.
 *
 * Architecture note: `rrweb-player` is a Svelte component that mutates
 * the DOM of its `target` element. React, in turn, owns its own
 * children's DOM. To prevent `removeChild` clashes during reconciliation
 * we keep the two trees in separate DOM subtrees:
 *   - One React-rendered overlay div for our controls + loading state.
 *   - One sibling `<div ref={mountRef} />` that React renders ONCE,
 *     never updates, and never adds children to. The Svelte player
 *     owns this node's contents exclusively.
 *
 * Recording payload shape: `runner/recordings.py` stores the
 * `/v1/sessions/{id}/recording` response verbatim, which is an array of
 * `{ data, sessionId, timestamp, type }`. `rrweb-player` expects
 * `eventWithTime` (`{ data, timestamp, type }`) so we strip `sessionId`
 * before handing them off.
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
  play?: () => void
  toggle?: () => void
  setSpeed?: (speed: number) => void
  goto?: (timeOffset: number, play?: boolean) => void
  $destroy?: () => void
  /**
   * Svelte component prop-update hatch. We use this to push new
   * width/height into the player so it can rescale its replayer
   * iframe on container resize (e.g. when the user expands the card
   * to a larger modal).
   */
  $set?: (props: Record<string, unknown>) => void
  addEventListener?: (event: string, handler: (params: unknown) => unknown) => void
  getMetaData?: () => { startTime: number; endTime: number; totalTime: number }
}

const SPEED_OPTIONS = [0.5, 1, 2, 4]

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function RecordingPlayer({ recordingUrl, className }: RecordingPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<RrwebPlayerInstance | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalTime, setTotalTime] = useState(0)
  const [speed, setSpeed] = useState(1)

  useEffect(() => {
    let cancelled = false
    let player: RrwebPlayerInstance | null = null
    let resizeObserver: ResizeObserver | null = null
    const target = mountRef.current

    async function init() {
      if (!target) return

      setStatus('loading')
      setErrorMessage(null)
      setIsPlaying(false)
      setCurrentTime(0)
      setTotalTime(0)
      setSpeed(1)

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

        // Initial size; the ResizeObserver below keeps the player in
        // sync with the container as the user expands / collapses.
        const measuredWidth = Math.max(320, target.clientWidth || 720)
        const measuredHeight = Math.max(
          180,
          target.clientHeight || Math.round(measuredWidth * (9 / 16)),
        )

        player = new rrwebPlayer({
          target,
          props: {
            events: events as never,
            width: measuredWidth,
            height: measuredHeight,
            autoPlay: false,
            // We render our own controls; rrweb's default controller
            // bar is not shown.
            showController: false,
            skipInactive: true,
            speed: 1,
          },
        }) as unknown as RrwebPlayerInstance
        playerRef.current = player

        const meta = player.getMetaData?.()
        if (meta) setTotalTime(meta.totalTime)

        // ui-update-current-time fires at ~16ms cadence during playback.
        player.addEventListener?.('ui-update-current-time', (payload: unknown) => {
          const p = payload as { payload?: number }
          if (typeof p?.payload === 'number') setCurrentTime(p.payload)
        })

        // ui-update-player-state fires whenever play/pause/end transitions.
        player.addEventListener?.('ui-update-player-state', (payload: unknown) => {
          const p = payload as { payload?: 'playing' | 'paused' | 'live' }
          if (p?.payload === 'playing') setIsPlaying(true)
          else if (p?.payload === 'paused') setIsPlaying(false)
        })

        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect
            if (!rect) return
            try {
              // Push the new container size into the Svelte player so
              // it rescales the replayer iframe. `triggerResize` alone
              // only nudges the player to recompute scale against its
              // *current* (unchanged) width/height props — useless
              // when the wrapper actually grew (e.g. on expand).
              const nextWidth = Math.max(320, Math.floor(rect.width))
              const nextHeight = Math.max(180, Math.floor(rect.height))
              player?.$set?.({ width: nextWidth, height: nextHeight })
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
        player?.$destroy?.()
      } catch {
        // ignore
      }
      playerRef.current = null
    }
  }, [recordingUrl])

  function handleTogglePlay() {
    const player = playerRef.current
    if (!player) return
    try {
      player.toggle?.()
    } catch {
      // rrweb-player can throw "replayer destroyed" if it raced with
      // an unmount; safe to ignore.
    }
  }

  function handleSetSpeed(next: number) {
    const player = playerRef.current
    if (!player) return
    try {
      player.setSpeed?.(next)
      setSpeed(next)
    } catch {
      // ignore
    }
  }

  function handleSeek(event: React.ChangeEvent<HTMLInputElement>) {
    const player = playerRef.current
    if (!player) return
    const next = Number(event.target.value)
    if (!Number.isFinite(next)) return
    try {
      player.goto?.(next, isPlaying)
      setCurrentTime(next)
    } catch {
      // ignore
    }
  }

  // Format speed labels exactly like the screenshot: ".5x", "1x", "2x", "4x".
  const speedLabel = useMemo(() => formatSpeed(speed), [speed])

  return (
    <ExpandableContainer
      className={cn('bg-black', className)}
      collapsedClassName="flex flex-col"
    >
      {({ expanded, ExpandToggle }) => (
        <div
          className={cn(
            'flex flex-col bg-black',
            expanded ? 'h-full' : 'w-full',
          )}
        >
          {/*
            Frame area: rrweb mount + overlay controls. When collapsed
            it's a 16:9 box; when expanded it grows to fill the modal
            height with `flex-1 min-h-0`. The ResizeObserver installed
            during init() pushes new width/height into the Svelte
            player whenever this box resizes, keeping the rrweb iframe
            scaled to fit.
          */}
          <div
            className={cn(
              'relative overflow-hidden bg-black',
              expanded ? 'flex-1 min-h-0' : 'aspect-[16/9]',
            )}
          >
            {/*
              Svelte player mounts here. This div has NO React
              children — React renders it once and never reconciles
              its contents. The control overlays sit on a separate
              absolutely-positioned subtree so React can update them
              freely without touching this node.
            */}
            <div ref={mountRef} className="rrweb-player-mount absolute inset-0" />

            {/* Expand toggle, pinned bottom-right of the visual frame
                so it doesn't sit awkwardly over the seek bar. */}
            {status === 'ready' && (
              <ExpandToggle
                expandLabel="Expand recording"
                collapseLabel="Close expanded recording"
              />
            )}

            {status === 'ready' && (
              <>
                {/*
                  Speed pill. Shifted leftward when expanded so it
                  doesn't collide with the modal close button (which
                  also sits top-right).
                */}
                <div
                  className={cn(
                    'absolute z-10',
                    expanded ? 'right-14 top-3' : 'right-2 top-2',
                  )}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="inline-flex h-7 min-w-[36px] items-center justify-center rounded-md bg-white/95 px-2 text-[11px] font-medium text-foreground shadow-sm ring-1 ring-black/5 hover:bg-white transition-colors"
                      aria-label="Playback speed"
                    >
                      {speedLabel}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={4} className="min-w-[64px]">
                      {SPEED_OPTIONS.map((option) => (
                        <DropdownMenuItem
                          key={option}
                          onClick={() => handleSetSpeed(option)}
                          className={cn(
                            'justify-center text-[12px] font-medium',
                            option === speed && 'font-semibold',
                          )}
                        >
                          {formatSpeed(option)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <button
                  type="button"
                  onClick={handleTogglePlay}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  className="group/play absolute inset-0 z-10 flex items-center justify-center focus:outline-none"
                >
                  <span
                    className={cn(
                      'flex size-14 items-center justify-center rounded-full bg-foreground/85 text-background shadow-lg ring-1 ring-black/10 transition-opacity duration-150',
                      isPlaying
                        ? 'opacity-0 group-hover/play:opacity-100 group-focus-visible/play:opacity-100'
                        : 'opacity-100',
                    )}
                  >
                    {isPlaying ? (
                      <Pause className="size-5" fill="currentColor" />
                    ) : (
                      <Play className="size-5 translate-x-[1px]" fill="currentColor" />
                    )}
                  </span>
                </button>
              </>
            )}

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

          {/* Seek + elapsed-time row, pinned below the frame and
              inside the expandable container so it scales with the
              modal when the user expands. */}
          {status === 'ready' && (
            <div className="flex items-center gap-3 bg-background px-4 py-2.5 shrink-0">
              <span className="tabular-nums text-[11px] text-muted-foreground min-w-[36px]">
                {formatTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(1, totalTime)}
                value={Math.min(currentTime, totalTime)}
                step={50}
                onChange={handleSeek}
                aria-label="Seek"
                className="recording-player-seek flex-1"
              />
            </div>
          )}
        </div>
      )}
    </ExpandableContainer>
  )
}

function formatSpeed(value: number): string {
  if (value === 0.5) return '.5x'
  return `${value}x`
}
