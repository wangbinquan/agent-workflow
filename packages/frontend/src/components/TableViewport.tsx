// RFC-198 — semantic, keyboard-reachable horizontal overflow for native tables.
//
// The table remains the callsite's native element (including its existing
// classes, testids and event handlers). This primitive owns only the wrapper,
// the real scroll container and the overflow-edge affordance state.

import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from 'react'

export interface TableViewportProps {
  label: string
  minWidth?: 'sm' | 'md' | 'lg'
  children: ReactElement<ComponentPropsWithoutRef<'table'>, 'table'>
}

interface OverflowState {
  hasOverflow: boolean
  overflowStart: boolean
  overflowEnd: boolean
}

const INITIAL_OVERFLOW_STATE: OverflowState = {
  hasOverflow: false,
  overflowStart: false,
  overflowEnd: false,
}

// scrollLeft can be fractional at non-integer zoom levels. Treat a sub-pixel
// remainder as the edge so the fade does not flicker when the browser settles.
const SCROLL_EDGE_EPSILON = 0.5

function directTableChild(scroller: HTMLDivElement): HTMLTableElement | null {
  const child = scroller.firstElementChild
  return child?.tagName === 'TABLE' ? (child as HTMLTableElement) : null
}

export function TableViewport({ label, minWidth = 'md', children }: TableViewportProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState<OverflowState>(INITIAL_OVERFLOW_STATE)
  const isNativeTableChild = isValidElement(children) && children.type === 'table'

  useEffect(() => {
    if (import.meta.env.DEV && !isNativeTableChild) {
      console.warn(
        'TableViewport requires exactly one direct native <table> child; wrappers and custom table components are not supported.',
      )
    }
  }, [isNativeTableChild])

  const measure = useCallback(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return

    const { clientWidth, scrollLeft, scrollWidth } = scroller
    const hasOverflow = scrollWidth > clientWidth
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
    const overflowStart = hasOverflow && scrollLeft > SCROLL_EDGE_EPSILON
    const overflowEnd = hasOverflow && maxScrollLeft - scrollLeft > SCROLL_EDGE_EPSILON

    setOverflow((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.overflowStart === overflowStart &&
        current.overflowEnd === overflowEnd
      ) {
        return current
      }
      return { hasOverflow, overflowStart, overflowEnd }
    })
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return

    // Measure synchronously after every relevant commit so the region does not
    // wait for ResizeObserver delivery before entering/leaving the tab order.
    measure()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measure)
    observer.observe(scroller)

    // The table can grow without changing the scroller's content box (for
    // example after async cell text arrives), so observe both DOM nodes.
    const table = directTableChild(scroller)
    if (table !== null) observer.observe(table)

    return () => observer.disconnect()
  }, [children, measure, minWidth])

  return (
    <div
      className={`table-viewport table-viewport--${minWidth}`}
      data-overflow-start={overflow.overflowStart}
      data-overflow-end={overflow.overflowEnd}
    >
      <div
        ref={scrollerRef}
        className="table-viewport__scroller"
        role={overflow.hasOverflow ? 'region' : undefined}
        aria-label={overflow.hasOverflow ? label : undefined}
        tabIndex={overflow.hasOverflow ? 0 : undefined}
        onScroll={measure}
      >
        {children}
      </div>
      <span className="table-viewport__hint" aria-hidden="true" />
    </div>
  )
}
