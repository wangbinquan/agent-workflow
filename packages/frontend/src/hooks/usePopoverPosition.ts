// RFC-173 (T1) — shared portal-popover positioning.
//
// Select, UserPicker (and now MultiSelect) all portal their dropdown to
// document.body so ancestors with overflow:hidden can't clip it, then anchor
// it manually from the trigger's bounding rect and re-anchor on every scroll
// (capture phase, to catch ancestor scroll) / resize while open. That effect
// was byte-identical in three places (Select.tsx / UserPicker.tsx); this hook
// is the single source.
//
// ONLY the positioning is shared — each component keeps its own keyboard /
// selection state machine (Select's Enter=select+close vs MultiSelect's
// Enter=toggle+stay-open are deliberately not unified).

import { useLayoutEffect, useState, type RefObject } from 'react'

export interface PopoverPosition {
  left: number
  top: number
  width: number
}

/**
 * Anchor a portaled popover under `triggerRef`. Returns viewport-anchored
 * window-scroll coords (`left`/`top`/`width`) while `open`, else the last
 * computed value (callers gate rendering on `open` anyway). Recomputes on
 * open and on every scroll/resize while open; tears the listeners down on
 * close/unmount.
 *
 * The ref is nullable (`RefObject<T | null>`) to match `useRef<T>(null)` under
 * React 19 types — Select/UserPicker both pass such a ref.
 */
export function usePopoverPosition<T extends HTMLElement>(
  triggerRef: RefObject<T | null>,
  open: boolean,
  popoverRef?: RefObject<HTMLElement | null>,
): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const gap = 4
    const viewportMargin = 8
    function recompute() {
      const el = triggerRef.current
      if (el === null) return
      const r = el.getBoundingClientRect()
      const popoverHeight = popoverRef?.current?.getBoundingClientRect().height ?? 0
      const spaceBelow = window.innerHeight - r.bottom - gap - viewportMargin
      const spaceAbove = r.top - gap - viewportMargin
      const placeAbove = popoverHeight > 0 && popoverHeight > spaceBelow && spaceAbove > spaceBelow
      const viewportTop = placeAbove ? r.top - gap - popoverHeight : r.bottom + gap
      const clampedViewportTop =
        popoverHeight > 0
          ? Math.min(
              Math.max(viewportMargin, viewportTop),
              Math.max(viewportMargin, window.innerHeight - viewportMargin - popoverHeight),
            )
          : viewportTop
      const next = {
        left: r.left + window.scrollX,
        top: clampedViewportTop + window.scrollY,
        width: r.width,
      }
      setPos((current) =>
        current?.left === next.left && current.top === next.top && current.width === next.width
          ? current
          : next,
      )
    }
    recompute()
    // The first measurement creates the portaled element. Measure once more
    // before the next paint so a list near the viewport edge can use its real
    // height and flip above the trigger without a visible jump.
    const frame = window.requestAnimationFrame(recompute)
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [open, popoverRef, triggerRef])

  return pos
}
