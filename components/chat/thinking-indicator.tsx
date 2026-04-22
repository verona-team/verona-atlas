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

interface ThinkingIndicatorProps {
  className?: string
}

export function ThinkingIndicator({ className = '' }: ThinkingIndicatorProps) {
  // Seed the initial verb randomly on mount. The indicator no longer tracks
  // absolute elapsed time — on a hard refresh we'd lose the original start
  // timestamp and the counter would confusingly reset to 0s, so it's gone.
  const [verbIdx, setVerbIdx] = useState(() =>
    Math.floor(Math.random() * VERBS.length),
  )
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

    const dotsId = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '·'))
    }, 400)

    return () => {
      clearInterval(verbId)
      clearInterval(dotsId)
    }
  }, [])

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
        <span className="inline-block w-4 text-left text-muted-foreground/60">
          {dots}
        </span>
      </span>
    </div>
  )
}
