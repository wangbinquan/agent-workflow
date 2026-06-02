// RFC-078 — locks the pure derivation of a review node's "this-round-started"
// display anchor from its doc_versions, and the timeline sort comparator.
//
// Why this test exists: the task-detail timeline used to render a review row's
// raw node_runs.started_at (the slot-first-open tick, never re-stamped across
// refresh/iterate reuse), so "start" could predate the reviewed agent run by
// ~25h (task 01KT1HDYV6RA8EJGY5BSE20MH9 rev_cbkatx) and "duration" conflated
// human think-time with multiple iterate reruns. deriveReviewRoundTiming pins
// the display to the current pending doc_version's created_at instead. If a
// future refactor breaks any branch here, the timeline silently regresses to
// the misleading raw started_at.

import { describe, expect, test } from 'bun:test'
import {
  compareNodeRunsForTimeline,
  deriveReviewRoundTiming,
  type ReviewVersionFacts,
} from '../src/services/reviewRoundStart'

const v = (
  versionIndex: number,
  createdAt: number,
  decision: ReviewVersionFacts['decision'],
  decidedAt: number | null = null,
): ReviewVersionFacts => ({ versionIndex, createdAt, decision, decidedAt })

describe('RFC-078 deriveReviewRoundTiming', () => {
  test('no versions → null (non-review row, or pre-content review row)', () => {
    expect(deriveReviewRoundTiming({ startedAt: 1000 }, [])).toBeNull()
    expect(deriveReviewRoundTiming({ startedAt: null }, [])).toBeNull()
  })

  test('single pending (fresh mint) → that pending version, no decidedAt', () => {
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [v(1, 5000, 'pending')])
    expect(t).toEqual({ roundStartedAt: 5000, decidedAt: null })
  })

  test('refreshed (old superseded + new pending) → the NEW pending created_at', () => {
    // started_at=100 is far before either version — the bug scenario.
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [
      v(1, 5000, 'superseded'),
      v(2, 9000, 'pending'),
    ])
    expect(t).toEqual({ roundStartedAt: 9000, decidedAt: null })
  })

  test('approved terminal (no pending, highest non-superseded approved) → that version + its decidedAt', () => {
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [
      v(1, 5000, 'superseded'),
      v(2, 9000, 'approved', 9500),
    ])
    expect(t).toEqual({ roundStartedAt: 9000, decidedAt: 9500 })
  })

  test('iterated then re-pending → the new pending (skips the iterated version)', () => {
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [
      v(1, 5000, 'iterated', 5500),
      v(2, 9000, 'pending'),
    ])
    expect(t).toEqual({ roundStartedAt: 9000, decidedAt: null })
  })

  test('many rounds (superseded×N + iterated×M + one pending) → the unique pending', () => {
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [
      v(1, 1000, 'superseded'),
      v(2, 2000, 'iterated', 2500),
      v(3, 3000, 'superseded'),
      v(4, 4000, 'iterated', 4500),
      v(5, 5000, 'pending'),
    ])
    expect(t).toEqual({ roundStartedAt: 5000, decidedAt: null })
  })

  test('all superseded (transient refresh window) → fall back to run.startedAt', () => {
    expect(deriveReviewRoundTiming({ startedAt: 777 }, [v(1, 5000, 'superseded')])).toEqual({
      roundStartedAt: 777,
      decidedAt: null,
    })
    // startedAt may itself be null (never-stamped) — propagate it.
    expect(deriveReviewRoundTiming({ startedAt: null }, [v(1, 5000, 'superseded')])).toEqual({
      roundStartedAt: null,
      decidedAt: null,
    })
  })

  test('multiple pendings on different ports → highest versionIndex wins (versionIndex tiebreak, not created_at)', () => {
    // Defensive: equal-ms created_at across two pending versions; versionIndex decides.
    const t = deriveReviewRoundTiming({ startedAt: 100 }, [
      v(2, 9000, 'pending'),
      v(3, 9000, 'pending'),
    ])
    expect(t).toEqual({ roundStartedAt: 9000, decidedAt: null })
  })
})

describe('RFC-078 compareNodeRunsForTimeline', () => {
  const sortIds = (rows: Parameters<typeof compareNodeRunsForTimeline>[0][]) =>
    [...rows].sort(compareNodeRunsForTimeline).map((r) => r.id)

  test('review row sorts by its round anchor, not its pinned started_at', () => {
    // The review's started_at (100) is the earliest, but its content round
    // anchor (9000) is the latest — it must sort LAST, after the agent run.
    const review = { id: 'rev', startedAt: 100, reviewRoundStartedAt: 9000 }
    const agent = { id: 'agent', startedAt: 5000, reviewRoundStartedAt: null }
    expect(sortIds([review, agent])).toEqual(['agent', 'rev'])
  })

  test('non-review rows fall back to started_at; id breaks ties', () => {
    const a = { id: 'aaa', startedAt: 5000 }
    const b = { id: 'bbb', startedAt: 5000 }
    const c = { id: 'ccc', startedAt: 1000 }
    expect(sortIds([a, b, c])).toEqual(['ccc', 'aaa', 'bbb'])
  })

  test('null anchors sort as 0 (NULL-first, matching old asc(started_at))', () => {
    const started = { id: 'z', startedAt: 10 }
    const neverStarted = { id: 'a', startedAt: null }
    expect(sortIds([started, neverStarted])).toEqual(['a', 'z'])
  })
})
