// RFC-082 regression: the comment-sidebar ▲/▼ jump (and J/K) must read the
// CURRENT selection from a ref, NOT the closed-over React state.
//
// Bug (found 2026-06-04 on the live single-doc review page): clicking the ▲/▼
// arrow rapidly to reach the first / last comment only advanced ONE step, so
// the user "couldn't switch to the first comment / the scroll didn't follow".
// Root cause: `jumpComment` computed the next index from `activeCommentId`
// (React state) read out of the callback closure. React batches the state
// updates, so several synchronous clicks all saw the same stale value and each
// computed the same single-step target. The fix mirrors the selection into
// `activeCommentIdRef`, updated synchronously by `selectComment`, and reads the
// ref inside `jumpComment` — so every click sees the latest selection.
//
// Locked at source level: the race is a React state-batching timing issue that
// jsdom can't reliably reproduce (no layout / smooth scroll / IO scroll-spy).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PANE = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx'),
  'utf8',
)

describe('ReviewDocPane — jumpComment reads selection from a ref (rapid-click fix)', () => {
  test('an activeCommentIdRef exists and selectComment syncs it with the state', () => {
    expect(PANE).toMatch(/activeCommentIdRef\s*=\s*useRef/)
    // selectComment writes the ref synchronously THEN the state, so the ref is
    // always current even between batched synchronous clicks.
    expect(PANE).toMatch(
      /selectComment\s*=\s*useCallback\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?activeCommentIdRef\.current\s*=\s*id[\s\S]*?setActiveCommentId\(id\)/,
    )
  })

  test('jumpComment computes the current index from the ref, not the closed-over state', () => {
    const start = PANE.indexOf('const jumpComment')
    const end = PANE.indexOf('const currentCommentIdx')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = PANE.slice(start, end)
    // Reads the live selection from the ref…
    expect(body).toMatch(/activeCommentIdRef\.current/)
    // …and never the React state directly (that's the batching bug). The
    // negative lookahead allows `activeCommentIdRef` but forbids bare
    // `activeCommentId`.
    expect(body).not.toMatch(/\bactiveCommentId\b(?!Ref)/)
    // Selection changes route through selectComment so the ref stays synced.
    expect(body).toMatch(/selectComment\(/)
  })

  test('bubble click + scroll-spy also go through selectComment (keep the ref synced)', () => {
    // onBubbleClick selects via the ref-syncing setter…
    const bc = PANE.slice(PANE.indexOf('const onBubbleClick'), PANE.indexOf('const jumpComment'))
    expect(bc).toMatch(/selectComment\(/)
    // …and the IntersectionObserver scroll-spy does too, so a scroll-driven
    // active change is visible to the next jumpComment.
    expect(PANE).toMatch(/dataset\.commentId[\s\S]{0,80}selectComment\(/)
  })
})

describe('ReviewDocPane — jump scroll lands reliably under a real mouse click', () => {
  test('scrollToCommentAnchor uses an instant scroll (behavior: auto), not smooth', () => {
    // Bug (found 2026-06-04 with a REAL mouse click — programmatic .click()
    // masked it): clicking the ▲/▼ jump button (mousedown / focus + the React
    // re-render around the handler) cancels an in-flight `behavior: 'smooth'`
    // scrollIntoView partway, so the document stops between comments and the
    // jump "does nothing". An instant scroll has no animation to cancel.
    const fn = PANE.slice(
      PANE.indexOf('const scrollToCommentAnchor'),
      PANE.indexOf('const onBubbleClick'),
    )
    expect(fn).toMatch(/scrollIntoView\(\s*\{[^}]*behavior:\s*'auto'/)
    expect(fn).not.toMatch(/behavior:\s*'smooth'/)
  })
})
