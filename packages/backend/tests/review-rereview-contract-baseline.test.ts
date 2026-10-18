// RFC-074 PR-A baseline — review re-review contract, locked at the helpers
// PR-B rewrites/deletes (A13-A17).
//
// WHY THIS FILE EXISTS (regression intent):
//   The integration-level review contract (approve propagates, iterate mints,
//   reject terminates, sibling cascade) is already locked by the combination
//   scenarios (S1/S5/S9/S16) and the existing review-* suites. What PR-B
//   actually TOUCHES is two pure helpers:
//     - `isReviewClarifyAlignedWithUpstream` — the cci-based short-circuit
//       that `dispatchReviewNode` uses to decide "prior approval still covers
//       the upstream → skip re-review". PR-B DELETES this (plan T-B9), letting
//       provenance freshness decide instead. We lock its full truth table so
//       PR-B can prove the deletion preserves the observable re-review
//       contract (RFC-005 US-2: upstream genuinely advanced → re-review fires;
//       upstream unchanged → no spurious re-review).
//     - `pickFreshestReviewRun` — dual-pick (freshest reuse row + freshest
//       done row) PR-B keeps but feeds a unified picker. Locked so the
//       reuse/latestDone selection does not silently drift.
//
//   When PR-B removes `isReviewClarifyAlignedWithUpstream`, A13-A16 are
//   expected to be deleted WITH it — but only after the provenance equivalent
//   reproduces the same fire/skip decisions (B18). They are the before-photo.

import { describe, expect, test } from 'bun:test'
import { pickFreshestReviewRun } from '@/modules/collaboration/infrastructure/review'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

// Helpers read only (id, retryIndex, status, parentNodeRunId).
function row(opts: {
  id?: string
  cci?: number
  retryIndex?: number
  status?: string
  parentNodeRunId?: string | null
}): Row {
  return {
    id: opts.id ?? '01X',
    retryIndex: opts.retryIndex ?? 0,
    status: opts.status ?? 'done',
    parentNodeRunId: opts.parentNodeRunId ?? null,
  } as unknown as Row
}

// RFC-074 PR-C: A13-A16 locked `isReviewClarifyAlignedWithUpstream` (the
// cci-based short-circuit). PR-B deleted that helper — the re-review fire/skip
// decision is now driven by provenance (`coversSource` / consumed-run id),
// exercised end-to-end by the combination scenarios (S1/S5/S9/S16) and
// review-dispatch-cci's "stale provenance → US-2 re-review" integration test.
// Only the surviving pure helper (`pickFreshestReviewRun`, A17) stays here.
describe('RFC-074 — review re-review contract (A17)', () => {
  // A17 — pickFreshestReviewRun dual-pick: `reuse` = freshest top-level row by
  // id (RFC-074 PR-C: pure ULID order) regardless of status; `latestDone` =
  // freshest top-level row that is `done`. Fan-out child rows (parentNodeRunId
  // != null) are excluded from BOTH even when they would rank highest.
  // Ids are CAUSAL: the awaiting row was minted after the done row (it is the
  // clarify-bumped successor), so it carries the larger id.
  test('A17: reuse = freshest top-level; latestDone = freshest done; children excluded', () => {
    const done0 = row({ id: '01A_DONE0', cci: 0, status: 'done' })
    const awaiting1 = row({ id: '01B_AWAIT1', cci: 1, status: 'awaiting_review' })
    const childHigh = row({
      id: '01C_CHILD2',
      cci: 2,
      status: 'done',
      parentNodeRunId: '01B_AWAIT1',
    })
    const { reuse, latestDone } = pickFreshestReviewRun([done0, awaiting1, childHigh])
    // Freshest top-level overall is the later-minted awaiting row (child excluded).
    expect(reuse?.id).toBe('01B_AWAIT1')
    // Freshest DONE top-level is the done row (awaiting is not done; child excluded).
    expect(latestDone?.id).toBe('01A_DONE0')
  })
})
