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
  // an absolute elapsed time — on a hard refresh we'd lose the original
  // start timestamp and the counter would confusingly reset, so the UX now
  // relies purely on a dynamic animation to communicate "still working".
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
      <GearsWithSparks />
      <span className="font-mono tabular-nums text-foreground/70">
        {VERBS[verbIdx]}
        <span className="inline-block w-4 text-left text-muted-foreground/60">
          {dots}
        </span>
      </span>
    </div>
  )
}

/**
 * Two interlocking gears turning in opposite directions with sparks flying
 * off the meshing point. Built with SVG + CSS keyframes (defined in
 * `globals.css`) so it stays crisp at any zoom level and doesn't require a
 * JS render loop.
 */
function GearsWithSparks() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block size-5 shrink-0"
    >
      {/* Large gear, bottom-left */}
      <svg
        viewBox="-6 -6 12 12"
        className="thinking-gear-cw absolute left-0 top-1 size-3.5"
      >
        <Gear rOuter={4.5} rInner={3} teeth={8} />
      </svg>

      {/* Small gear, top-right — teeth visually mesh with the large one */}
      <svg
        viewBox="-4 -4 8 8"
        className="thinking-gear-ccw absolute right-0 top-0 size-2.5"
      >
        <Gear rOuter={3} rInner={2} teeth={6} />
      </svg>

      {/* Sparks rendered on top, emanating from the meshing point */}
      <svg
        viewBox="0 0 20 20"
        className="pointer-events-none absolute inset-0 size-5 overflow-visible"
      >
        <Spark delay="0s" dx={5} dy={-4} />
        <Spark delay="0.35s" dx={6} dy={-2} />
        <Spark delay="0.7s" dx={3} dy={-5} />
      </svg>
    </span>
  )
}

interface GearProps {
  rOuter: number
  rInner: number
  teeth: number
}

function Gear({ rOuter, rInner, teeth }: GearProps) {
  const points: string[] = []
  const toothDepth = rOuter - rInner
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? rOuter + toothDepth * 0.25 : rInner
    const angle = (i / (teeth * 2)) * Math.PI * 2
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return (
    <>
      <polygon
        points={points.join(' ')}
        className="fill-foreground/25 stroke-foreground/70"
        strokeWidth={0.6}
        strokeLinejoin="round"
      />
      <circle
        cx={0}
        cy={0}
        r={rInner * 0.35}
        className="fill-background stroke-foreground/70"
        strokeWidth={0.6}
      />
    </>
  )
}

interface SparkProps {
  delay: string
  dx: number
  dy: number
}

function Spark({ delay, dx, dy }: SparkProps) {
  return (
    <g
      className="thinking-spark text-amber-500"
      style={
        {
          '--spark-dx': `${dx}px`,
          '--spark-dy': `${dy}px`,
          animationDelay: delay,
        } as React.CSSProperties
      }
    >
      <line
        x1={11}
        y1={9}
        x2={12}
        y2={8}
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
      />
    </g>
  )
}
