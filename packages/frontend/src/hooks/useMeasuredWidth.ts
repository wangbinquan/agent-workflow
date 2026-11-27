// RFC-616 — the rendered width of an element, re-measured when it resizes.
// Chart components size their marks from it (which labels fit, how wide a line
// chart draws). `null` until the first measurement and wherever layout cannot be
// measured, so callers always have a sensible unmeasured rendering.
//
// The ref is a callback: the element is measured whenever it attaches, also when
// the component first renders without it (a chart that has nothing to draw yet)
// and it appears on a later render.
import { useEffect, useState } from 'react'

export function useMeasuredWidth<T extends HTMLElement>(): [
  (element: T | null) => void,
  number | null,
] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    if (element === null) return
    const measure = () => {
      const next = element.getBoundingClientRect().width
      setWidth((previous) => (previous === next || next === 0 ? previous : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}
