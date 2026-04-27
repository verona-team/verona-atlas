'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import type { Json } from '@/lib/supabase/types'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { RecordingPlayer } from './recording-player'
import { ExpandableContainer } from './expandable-frame'

export interface LiveSessionMetadata {
  status?: 'running' | 'passed' | 'failed' | 'error'
  run_id?: string
  test_template_id?: string
  template_name?: string
  browserbase_session_id?: string
  live_view_url?: string | null
  live_view_fullscreen_url?: string | null
  live_view_debugger_url?: string | null
  browserbase_dashboard_url?: string | null
  recording_url?: string | null
  error_message?: string | null
  duration_ms?: number | null
}

interface LiveSessionCardProps {
  /** Retained for future deep-link surfaces; currently unused since run detail pages were removed. */
  projectId?: string
  metadata: Record<string, Json>
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = seconds % 60
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`
}

export function LiveSessionCard({ metadata }: LiveSessionCardProps) {
  const meta = metadata as unknown as LiveSessionMetadata

  const status = meta.status ?? 'running'
  const isRunning = status === 'running'
  const isCompleted = !isRunning
  const isFailed = status === 'failed' || status === 'error'
  const templateName = meta.template_name ?? 'Test'
  const liveViewUrl = meta.live_view_url ?? meta.live_view_fullscreen_url ?? ''
  const recordingUrl = meta.recording_url ?? null
  const errorMessage = meta.error_message?.trim() || null

  const [disconnected, setDisconnected] = useState(false)
  const [errorExpanded, setErrorExpanded] = useState(false)

  useEffect(() => {
    if (!isRunning) return
    function onMessage(event: MessageEvent) {
      if (event.data === 'browserbase-disconnected') {
        setDisconnected(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [isRunning])

  const duration = formatDuration(meta.duration_ms)
  const canEmbedLive = isRunning && !!liveViewUrl && !disconnected

  const StatusIcon = isRunning
    ? Loader2
    : status === 'passed'
      ? CheckCircle2
      : status === 'failed'
        ? XCircle
        : AlertCircle

  const statusColor =
    status === 'passed'
      ? 'text-green-600'
      : status === 'failed'
        ? 'text-red-500/80'
        : status === 'error'
          ? 'text-amber-500/80'
          : 'text-foreground/60'

  const statusLabel = isRunning
    ? 'Running in a cloud browser'
    : status === 'passed'
      ? 'Passed'
      : status === 'failed'
        ? 'Failed'
        : 'Errored'

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border">
        <StatusIcon
          className={`size-4 ${statusColor} ${isRunning ? 'animate-spin' : ''}`}
        />
        <span className="text-sm font-medium text-foreground/90 truncate">
          {templateName}
        </span>
        <span className="text-xs text-muted-foreground ml-auto shrink-0">
          {statusLabel}
          {duration ? ` · ${duration}` : ''}
        </span>
      </div>

      {canEmbedLive ? (
        <ExpandableContainer
          className="bg-black"
          collapsedClassName="aspect-[16/9]"
        >
          {({ ExpandToggle }) => (
            <>
              <ScaledLiveIframe src={liveViewUrl} title={templateName} />
              <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
                Live
              </div>
              <ExpandToggle
                expandLabel="Expand live view"
                collapseLabel="Close expanded live view"
              />
            </>
          )}
        </ExpandableContainer>
      ) : isRunning && disconnected ? (
        <div className="flex items-center justify-center bg-muted/40 py-10 text-xs text-muted-foreground">
          Live view disconnected. Waiting for recording…
        </div>
      ) : null}

      {isCompleted && recordingUrl && (
        <RecordingPlayer recordingUrl={recordingUrl} />
      )}

      {isCompleted && !recordingUrl && (
        <div className="flex flex-col items-center justify-center gap-1.5 bg-muted/30 px-4 py-10 text-center">
          <AlertCircle className="size-4 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">
            Recording is not available for this session.
          </p>
        </div>
      )}

      {isCompleted && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border">
          {isFailed && errorMessage ? (
            <Collapsible open={errorExpanded} onOpenChange={setErrorExpanded} className="flex-1 min-w-0">
              <CollapsibleTrigger
                className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-expanded={errorExpanded}
              >
                {errorExpanded ? (
                  <ChevronDown className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {errorExpanded ? 'Hide failure details' : 'Show failure details'}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-2.5 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  {errorMessage}
                </p>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <span className="text-xs text-muted-foreground">
              {status === 'passed'
                ? 'Test completed successfully.'
                : isFailed
                  ? 'Test did not complete successfully.'
                  : ''}
            </span>
          )}
        </div>
      )}

      {isRunning && (
        <div className="px-4 py-2 border-t border-border">
          <p className="text-xs text-muted-foreground">
            This may take a while. You can safely navigate away — the test run
            will keep going in the background.
          </p>
        </div>
      )}
    </div>
  )
}

// Native size of the embedded Browserbase live-view iframe. The cross-origin
// embed always sees this exact viewport, regardless of how the wrapper is
// sized on screen — we scale the iframe visually with `transform: scale` so
// the embed never re-runs layout when the chat card expands or collapses.
// Re-layouts produce a visible flash (cut-off frames, weird internal borders)
// because the embed reflows its stream rendering for the new dimensions.
//
// 1280×720 matches the screen recorder's capture resolution
// (`runner/screen_recorder.py`), so the live and recorded views look
// identical at the same effective scale.
const LIVE_IFRAME_WIDTH = 1280
const LIVE_IFRAME_HEIGHT = 720

interface ScaledLiveIframeProps {
  src: string
  title: string
}

function ScaledLiveIframe({ src, title }: ScaledLiveIframeProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Drive the scale via direct DOM mutation in a ResizeObserver. Going
  // through React state would batch the update into a later commit, so
  // the iframe would render at the previous scale for one frame after
  // the wrapper jumps to its new collapsed/expanded dimensions —
  // visually that's exactly the "flash" we're trying to remove.
  // Mutating the inline transform style synchronously means the iframe
  // is in sync with the wrapper on the same paint.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const iframe = iframeRef.current
    if (!wrapper || !iframe) return

    function update() {
      if (!wrapper || !iframe) return
      const { width } = wrapper.getBoundingClientRect()
      if (width > 0) {
        iframe.style.transform = `scale(${width / LIVE_IFRAME_WIDTH})`
      }
    }

    update()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(wrapper)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden">
      <iframe
        ref={iframeRef}
        title={`Live browser session — ${title}`}
        src={src}
        sandbox="allow-same-origin allow-scripts"
        allow="clipboard-read; clipboard-write"
        className="absolute left-0 top-0 border-0"
        style={{
          width: `${LIVE_IFRAME_WIDTH}px`,
          height: `${LIVE_IFRAME_HEIGHT}px`,
          transformOrigin: 'top left',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
