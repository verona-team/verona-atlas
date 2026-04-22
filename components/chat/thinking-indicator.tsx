'use client'

import { useEffect, useState } from 'react'

const VERBS = [
  'Thinking',
  'Investigating',
  'Mapping flows',
  'Cross-referencing events',
  'Skimming your repo',
  'Drafting proposals',
  'Considering edge cases',
  'Consulting PostHog',
  'Weaving tests',
  'Reviewing your UI',
  'Prioritizing critical paths',
  'Tracing through code',
  'Pondering',
  'Scheming',
  'Spelunking',
  'Noodling',
  'Cooking',
  'Synthesizing',
  'Reasoning',
  'Sifting',
]

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

interface ThinkingIndicatorProps {
  startedAt: number
  className?: string
}

export function ThinkingIndicator({ startedAt, className = '' }: ThinkingIndicatorProps) {
  // Seed initial verb from `startedAt` to keep render pure. Subsequent verbs
  // are chosen randomly inside the interval (a side-effect context).
  const initialVerb = Math.abs(Math.floor(startedAt / 1000)) % VERBS.length
  const [verbIdx, setVerbIdx] = useState(initialVerb)
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
  const [dots, setDots] = useState('')

  useEffect(() => {
    const verbId = setInterval(() => {
      setVerbIdx((current) => {
        if (VERBS.length <= 1) return current
        let next = current
        while (next === current) {
          next = Math.floor(Math.random() * VERBS.length)
        }
        return next
      })
    }, 2200)

    const timeId = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 1000)

    const dotsId = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '·'))
    }, 400)

    return () => {
      clearInterval(verbId)
      clearInterval(timeId)
      clearInterval(dotsId)
    }
  }, [startedAt])

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2.5 text-sm text-muted-foreground ${className}`}
    >
      <span
        aria-hidden="true"
        className="inline-flex size-2 rounded-full bg-foreground/50 animate-pulse"
      />
      <span className="font-mono tabular-nums text-foreground/70">
        {VERBS[verbIdx]}
        <span className="inline-block w-4 text-left text-muted-foreground/60">{dots}</span>
      </span>
      <span className="text-muted-foreground/50 font-mono tabular-nums">
        · {formatElapsed(elapsed)}
      </span>
    </div>
  )
}
