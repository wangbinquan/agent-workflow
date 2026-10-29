// RFC-319 INTENT-X4 (e2e-webkit-nightly, run 40898004906; flaky on runs 40508998208 and
// 40700896223): "Return to latest" scrolled the intent timeline with `behavior: 'smooth'` even when
// the user prefers reduced motion. WebKit animates that scroll anyway, its intermediate scroll
// events dropped the timeline's pinned state, and the next turn neither followed nor hid the button.
// Reduced motion now jumps straight to the newest turn.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { prefersReducedMotion, scrollBehaviorForMotionPreference } from '../src/lib/reduced-motion'

function stubMatchMedia(matches: boolean | undefined) {
  vi.stubGlobal(
    'matchMedia',
    matches === undefined
      ? undefined
      : (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && matches }),
  )
}

describe('reduced-motion scroll behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('reduced motion jumps; otherwise the scroll stays smooth', () => {
    stubMatchMedia(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(scrollBehaviorForMotionPreference()).toBe('auto')
    stubMatchMedia(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehaviorForMotionPreference()).toBe('smooth')
  })

  test('an environment without matchMedia keeps the smooth default', () => {
    stubMatchMedia(undefined)
    expect(prefersReducedMotion()).toBe(false)
    expect(scrollBehaviorForMotionPreference()).toBe('smooth')
  })

  test('"Return to latest" on the intent timeline scrolls with the motion preference', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/routes/intent.detail.tsx'),
      'utf8',
    )
    const handler = source.slice(
      source.indexOf('className="btn btn--sm intent-session__return-latest"'),
      source.indexOf("{t('intent.returnToLatest')}"),
    )
    expect(handler).toContain('behavior: scrollBehaviorForMotionPreference()')
    expect(handler).not.toContain("behavior: 'smooth'")
  })
})
