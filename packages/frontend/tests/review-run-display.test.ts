// RFC-078 — pins the pure display helper that decides what a review node_run's
// timeline row shows. The compact NodeRunsTable (tasks.detail.tsx) and the
// NodeDetailDrawer both call reviewRunDisplay; if a refactor regresses it, both
// surfaces silently fall back to the misleading pinned started_at / compute
// duration (the original bug — task 01KT1HDYV6RA8EJGY5BSE20MH9 rev_cbkatx showed
// a 25h "duration" and a start time 25h before the reviewed run).

import { describe, expect, test } from 'vitest'
import { reviewRunDisplay } from '../src/lib/reviewRunDisplay'

describe('RFC-078 reviewRunDisplay', () => {
  test('non-review row (no round anchor): falls back to startedAt, no wait', () => {
    expect(
      reviewRunDisplay({ startedAt: 5000, reviewRoundStartedAt: null, reviewDecidedAt: null }),
    ).toEqual({
      isReview: false,
      displayStartedAt: 5000,
      reviewWaitMs: null,
    })
    // absent optional fields behave the same
    expect(reviewRunDisplay({ startedAt: 5000 })).toEqual({
      isReview: false,
      displayStartedAt: 5000,
      reviewWaitMs: null,
    })
  })

  test('awaiting review: shows round anchor (not pinned startedAt), wait null', () => {
    // startedAt=100 is the misleading pinned slot time; anchor=9000 is content.
    expect(
      reviewRunDisplay({ startedAt: 100, reviewRoundStartedAt: 9000, reviewDecidedAt: null }),
    ).toEqual({ isReview: true, displayStartedAt: 9000, reviewWaitMs: null })
  })

  test('decided review: wait = decided − round anchor (human review time, not compute)', () => {
    expect(
      reviewRunDisplay({ startedAt: 100, reviewRoundStartedAt: 9000, reviewDecidedAt: 9600 }),
    ).toEqual({ isReview: true, displayStartedAt: 9000, reviewWaitMs: 600 })
  })

  test('review anchor of 0 still counts as a review (nullish, not falsy)', () => {
    const d = reviewRunDisplay({ startedAt: null, reviewRoundStartedAt: 0, reviewDecidedAt: 0 })
    expect(d.isReview).toBe(true)
    expect(d.displayStartedAt).toBe(0)
    expect(d.reviewWaitMs).toBe(0)
  })

  test('null startedAt and no anchor → displayStartedAt null', () => {
    expect(reviewRunDisplay({ startedAt: null })).toEqual({
      isReview: false,
      displayStartedAt: null,
      reviewWaitMs: null,
    })
  })
})
