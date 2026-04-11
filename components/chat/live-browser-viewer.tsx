'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Monitor, Maximize2, Minimize2, Loader2, WifiOff } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface LiveBrowserViewerProps {
  runId: string
  templateName?: string
}

interface LiveSessionData {
  active: boolean
  liveViewUrl?: string
  templateName?: string
  startedAt?: string
}

export function LiveBrowserViewer({ runId, templateName }: LiveBrowserViewerProps) {
  const [session, setSession] = useState<LiveSessionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnected, setDisconnected] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const fetchLiveSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/live-session`)
      if (!res.ok) return
      const data = (await res.json()) as LiveSessionData
      setSession(data)
      if (data.active) {
        setDisconnected(false)
      }
      setLoading(false)
    } catch {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    void fetchLiveSession()

    pollRef.current = setInterval(() => {
      void fetchLiveSession()
    }, 5000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchLiveSession])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data === 'browserbase-disconnected') {
        setDisconnected(true)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  if (loading) {
    return (
      <Card size="sm" className="ring-0 border border-blue-500/20 bg-blue-500/5">
        <CardContent className="flex items-center gap-3">
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          <span className="text-sm text-muted-foreground">Connecting to live browser session...</span>
        </CardContent>
      </Card>
    )
  }

  if (!session?.active || !session.liveViewUrl) {
    return null
  }

  if (disconnected) {
    return (
      <Card size="sm" className="ring-0 border border-yellow-500/20 bg-yellow-500/5">
        <CardContent className="flex items-center gap-3">
          <WifiOff className="w-4 h-4 text-yellow-500" />
          <span className="text-sm text-muted-foreground">
            Browser session ended. Waiting for results...
          </span>
        </CardContent>
      </Card>
    )
  }

  const displayName = session.templateName || templateName || 'Test Flow'
  const iframeUrl = `${session.liveViewUrl}&navbar=false`

  return (
    <Card size="sm" className="ring-0 border border-blue-500/20 bg-blue-500/5 overflow-hidden">
      <CardContent className="space-y-3 p-0">
        <div className="flex items-center justify-between px-4 pt-3">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Monitor className="w-4 h-4 text-blue-500" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            </div>
            <span className="text-sm font-medium">Live: {displayName}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>

        <div
          className="relative w-full bg-black/5 dark:bg-white/5"
          style={{ height: expanded ? '600px' : '360px', transition: 'height 0.2s ease' }}
        >
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
            className="w-full h-full border-0 rounded-b-xl"
            style={{ pointerEvents: 'none' }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
