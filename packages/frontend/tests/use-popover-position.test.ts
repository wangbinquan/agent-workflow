// RFC-173 (T1) — locks the extracted usePopoverPosition hook. The three former
// copies (Select / UserPicker / and the would-be MultiSelect third) were only
// guarded by the host components' search/keyboard tests, which never exercised
// the rect math, the scroll/resize re-anchor, or listener cleanup (Codex R2
// P2-1). This file is that guard so the dedup is safe.

import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRef } from 'react'
import { usePopoverPosition } from '../src/hooks/usePopoverPosition'

function fakeTrigger(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      bottom: 0,
      width: 0,
      top: 0,
      right: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect
  return el
}

beforeEach(() => {
  // Deterministic scroll offsets.
  Object.defineProperty(window, 'scrollX', { value: 100, configurable: true })
  Object.defineProperty(window, 'scrollY', { value: 200, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePopoverPosition', () => {
  test('returns null while closed', () => {
    const ref = createRef<HTMLElement>()
    ref.current = fakeTrigger({ left: 10, bottom: 20, width: 30 })
    const { result } = renderHook(() => usePopoverPosition(ref, false))
    expect(result.current).toBeNull()
  })

  test('anchors from the trigger rect in window-scroll coords (+4 gap) when open', () => {
    const ref = createRef<HTMLElement>()
    ref.current = fakeTrigger({ left: 10, bottom: 20, width: 30 })
    const { result } = renderHook(() => usePopoverPosition(ref, true))
    expect(result.current).toEqual({ left: 110, top: 224, width: 30 })
  })

  test('re-anchors on scroll and resize while open', () => {
    const ref = createRef<HTMLElement>()
    const el = fakeTrigger({ left: 10, bottom: 20, width: 30 })
    ref.current = el
    const { result } = renderHook(() => usePopoverPosition(ref, true))
    expect(result.current).toEqual({ left: 110, top: 224, width: 30 })

    // Trigger moved (e.g. ancestor scrolled).
    el.getBoundingClientRect = () =>
      ({
        left: 50,
        bottom: 60,
        width: 30,
        top: 40,
        right: 80,
        height: 20,
        x: 50,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(result.current).toEqual({ left: 150, top: 264, width: 30 })

    el.getBoundingClientRect = () =>
      ({
        left: 5,
        bottom: 6,
        width: 7,
        top: 0,
        right: 12,
        height: 6,
        x: 5,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toEqual({ left: 105, top: 210, width: 7 })
  })

  test('removes scroll/resize listeners on close and unmount (cleanup)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const ref = createRef<HTMLElement>()
    ref.current = fakeTrigger({ left: 1, bottom: 2, width: 3 })

    const { rerender, unmount } = renderHook(({ open }) => usePopoverPosition(ref, open), {
      initialProps: { open: true },
    })
    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true)
    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function))

    // Closing tears the listeners down.
    rerender({ open: false })
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true)
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))

    removeSpy.mockClear()
    rerender({ open: true })
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true)
  })

  test('no-ops safely when the ref is null', () => {
    const ref = createRef<HTMLElement>()
    const { result } = renderHook(() => usePopoverPosition(ref, true))
    // recompute() early-returns on null ref → position stays null, no throw.
    expect(result.current).toBeNull()
  })
})
