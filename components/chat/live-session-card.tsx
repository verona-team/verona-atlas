'use client'

import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react'
import type { Json } from '@/lib/supabase/types'

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
  const templateName = meta.template_name ?? 'Test'
  const liveViewUrl = meta.live_view_url ?? meta.live_view_fullscreen_url ?? ''
  const dashboardUrl = meta.browserbase_dashboard_url ?? null

  const [disconnected, setDisconnected] = useState(false)

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
        ? 'text-red-600'
        : status === 'error'
          ? 'text-amber-600'
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
        <div className="relative bg-black">
          {/* 16:9 aspect ratio wrapper */}
          <div className="relative w-full pt-[56.25%]">
            <iframe
              title={`Live browser session — ${templateName}`}
              src={liveViewUrl}
              sandbox="allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              className="absolute inset-0 h-full w-full border-0"
              style={{ pointerEvents: 'none' }}
            />
          </div>
          <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
            <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
            Live
          </div>
        </div>
      ) : isRunning && disconnected ? (
        <div className="flex items-center justify-center bg-muted/40 py-10 text-xs text-muted-foreground">
          Live view disconnected. Waiting for recording…
        </div>
      ) : null}

      {!isRunning && (
        <div className="px-4 py-3 space-y-2">
          {meta.error_message && (
            <p className="text-xs text-red-600/90 whitespace-pre-wrap">
              {meta.error_message}
            </p>
          )}
          {dashboardUrl && (
            <div className="flex flex-wrap gap-2">
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
                Open in Browserbase
              </a>
            </div>
          )}
        </div>
      )}

      {isRunning && dashboardUrl && (
        <div className="px-4 py-2 border-t border-border">
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            Open session in Browserbase
          </a>
        </div>
      )}
    </div>
  )
}
