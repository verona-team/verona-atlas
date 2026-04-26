'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Maximize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Wraps a DOM-stateful child (live iframe, video element) in a
 * container that flips between an inline collapsed layout and a
 * centered fixed-position "modal" layout WITHOUT remounting children.
 *
 * Why CSS-only repositioning instead of a Portal: the Browserbase
 * live view is a long-lived `<iframe>`. Moving its DOM node remounts
 * it and tears down the realtime stream. The wrapper element stays
 * in the same React subtree across the toggle; only its className
 * changes. While expanded, a sibling placeholder is inserted ABOVE
 * the wrapper at the exact pixel size the wrapper occupied just
 * before expanding — so the surrounding chat doesn't snap shut.
 *
 * Children is a render-prop that receives `{ expanded, ExpandToggle }`.
 * Callers MUST render `<ExpandToggle />` somewhere they want the
 * expand/collapse button to appear (typically pinned bottom-right of
 * the visual frame). This lets consumers place the button correctly
 * regardless of whether their content includes a controls strip below
 * the frame.
 */

interface ExpandToggleProps {
  className?: string
  expandLabel?: string
  collapseLabel?: string
}

interface ExpandableContainerRenderProps {
  expanded: boolean
  ExpandToggle: (props: ExpandToggleProps) => ReactNode
}

interface ExpandableContainerProps {
  children: (props: ExpandableContainerRenderProps) => ReactNode
  className?: string
  collapsedClassName?: string
  expandedClassName?: string
}

export function ExpandableContainer({
  children,
  className,
  collapsedClassName,
  expandedClassName,
}: ExpandableContainerProps) {
  const [expanded, setExpanded] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const expandedRef = useRef(expanded)
  const [collapsedHeight, setCollapsedHeight] = useState<number | null>(null)
  const dialogId = useId()

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  // Track the collapsed wrapper's height so the moment the user
  // expands, the inline placeholder takes its exact pixel value and
  // the surrounding chat card doesn't snap shut. Skip updates while
  // expanded — the wrapper is fixed-positioned at 88vh in that state,
  // and the last-known collapsed height is what the placeholder
  // needs.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      if (expandedRef.current) return
      const rect = entries[0]?.contentRect
      if (!rect) return
      setCollapsedHeight(rect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!expanded) return

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKey)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [expanded])

  function ExpandToggle({
    className: btnClassName,
    expandLabel = 'Expand',
    collapseLabel = 'Close expanded view',
  }: ExpandToggleProps) {
    return (
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? collapseLabel : expandLabel}
        className={cn(
          'absolute z-30 inline-flex items-center justify-center rounded-md bg-black/70 text-white shadow-sm ring-1 ring-white/10 transition-opacity hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
          // Collapsed: hover-revealed inside the parent `group`.
          // Expanded: always visible, top-right of modal chrome.
          expanded
            ? 'right-3 top-3 size-8 opacity-100'
            : 'bottom-3 right-3 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          btnClassName,
        )}
      >
        {expanded ? <X className="size-4" /> : <Maximize2 className="size-3.5" />}
      </button>
    )
  }

  return (
    <>
      {expanded && (
        <div
          aria-hidden="true"
          style={{ height: collapsedHeight ?? undefined }}
          className="w-full"
        />
      )}

      <div
        ref={wrapperRef}
        role={expanded ? 'dialog' : undefined}
        aria-modal={expanded ? true : undefined}
        aria-labelledby={expanded ? `${dialogId}-label` : undefined}
        className={cn(
          'group relative overflow-hidden',
          className,
          expanded
            ? cn(
                'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[92vw] max-w-[1600px] h-[88vh] rounded-xl shadow-2xl ring-1 ring-white/10',
                expandedClassName,
              )
            : cn('w-full', collapsedClassName),
        )}
      >
        {expanded && (
          <span id={`${dialogId}-label`} className="sr-only">
            Expanded session viewer
          </span>
        )}

        {children({ expanded, ExpandToggle })}
      </div>

      {expanded && (
        <div
          aria-hidden="true"
          onClick={() => setExpanded(false)}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
        />
      )}
    </>
  )
}
