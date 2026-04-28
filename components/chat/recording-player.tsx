'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2, Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ExpandableContainer } from './expandable-frame'

/**
 * Renders a session recording inline as a native HTML5 ``<video>``
 * with custom React overlay controls: a centered play/pause button,
 * a top-right speed dropdown, and a thin progress + elapsed-time row
 * pinned below the frame.
 */

interface RecordingPlayerProps {
  recordingUrl: string
  className?: string
}

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8]

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSpeed(value: number): string {
  if (value === 0.5) return '.5x'
  return `${value}x`
}

export function RecordingPlayer({ recordingUrl, className }: RecordingPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalTime, setTotalTime] = useState(0)
  const [speed, setSpeed] = useState(1)

  function handleTogglePlay() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => {
        // Autoplay-blocked or user gesture missing; safe to ignore —
        // the click that fired this handler IS a user gesture so this
        // path is rare in practice.
      })
    } else {
      video.pause()
    }
  }

  function handleSetSpeed(next: number) {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = next
    setSpeed(next)
  }

  function handleSeek(event: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current
    if (!video) return
    const nextMs = Number(event.target.value)
    if (!Number.isFinite(nextMs)) return
    video.currentTime = nextMs / 1000
    setCurrentTime(nextMs)
  }

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
            Frame area: <video> + overlay controls. When collapsed it's
            a 16:9 box; when expanded it grows to fill the modal height
            with `flex-1 min-h-0`. The video element scales naturally
            via `object-contain`.
          */}
          <div
            className={cn(
              'relative overflow-hidden bg-black',
              expanded ? 'flex-1 min-h-0' : 'aspect-[16/9]',
            )}
          >
            <video
              ref={videoRef}
              src={recordingUrl}
              preload="metadata"
              playsInline
              className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(e) => {
                const video = e.currentTarget
                const d = video.duration
                if (Number.isFinite(d)) setTotalTime(d * 1000)
                // Nudge currentTime so the browser decodes and paints
                // the first frame as the still — `preload="metadata"`
                // alone leaves the frame area blank until the user
                // hits play. The backend trims the boot-up blank
                // intro, so the first frame is already meaningful.
                if (video.currentTime === 0) video.currentTime = 0.001
              }}
              onLoadedData={() => setStatus((s) => s === 'loading' ? 'ready' : s)}
              onError={() => {
                setStatus('error')
                setErrorMessage('Failed to load recording')
              }}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime * 1000)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />

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
                  also sits top-right). z-20 so it sits above the
                  full-frame play/pause button (z-10) — otherwise
                  clicks on the pill bubble through to play/pause.
                */}
                <div
                  className={cn(
                    'absolute z-20',
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

            {/*
              When expanded, overlay the seek bar at the bottom of the
              video frame so the modal is filled by the recording
              instead of having a separate light-coloured controls row
              underneath. The gradient lets the bottom of the video
              fade behind the controls (standard video-player chrome)
              instead of getting obscured by a hard panel. z-20 to sit
              above the full-frame play/pause button (z-10).
            */}
            {expanded && status === 'ready' && (
              <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center gap-3 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-4 pt-10 pb-3">
                <span className="tabular-nums text-[11px] text-white/80 min-w-[36px]">
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

          {/* Inline (collapsed) seek + elapsed-time row, pinned below
              the video frame so the chat card flow stays intact. */}
          {!expanded && status === 'ready' && (
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
