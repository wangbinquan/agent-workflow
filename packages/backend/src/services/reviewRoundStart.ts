// RFC-078 — review node "this-round-started" display anchor (PURE).
//
// A review node_run's `started_at` is stamped once, when its review slot first
// opens (review.ts:543, the dispatch tick), and is NEVER re-stamped: the
// awaiting-refresh reuse branch (review.ts:457-503) repoints
// consumed_upstream_runs_json without touching started_at, and a human iterate
// reuses the same row (review.ts:1474-1480). So `started_at` can predate the
// agent run a review ultimately reviews by hours (task 01KT1HDYV6RA8EJGY5BSE20MH9
// `rev_cbkatx` by ~25h), and `finished_at` is the human approve time — making the
// task-detail timeline's raw started_at / duration deeply misleading.
//
// The CONTENT a review round is actually looking at is the latest pending
// doc_version; each refresh / iterate mints a new doc_version with a fresh
// created_at (review.ts:638). So the meaningful "this round started" anchor is
// the current pending doc_version's created_at — already the single source of
// truth behind ReviewSummary.createdAt. We DO NOT re-stamp started_at (it is
// load-bearing in scheduler ORDER BY at scheduler.ts:790/1358 + resume
// idempotence); we only DERIVE a read-only display anchor at serialization time.
//
// PURE module: no DB / IO. Tested exhaustively in review-round-start.test.ts.

import type { DocVersionDecision } from '@agent-workflow/shared'

/** The per-version facts this module needs (a projection of a doc_versions row). */
export interface ReviewVersionFacts {
  createdAt: number
  versionIndex: number
  decision: DocVersionDecision
  decidedAt: number | null
}

export interface ReviewRoundTiming {
  /** When the current review round's content was produced (doc_version.created_at). */
  roundStartedAt: number | null
  /** When the current round was decided (null while still awaiting a human). */
  decidedAt: number | null
}

/**
 * Derive the current review round's content-anchored timing for one review
 * node_run, from its doc_versions.
 *
 *   no versions          → null   (NOT a review row, OR a pre-content review row;
 *                                  callers fall back to node_run.started_at)
 *   has a pending version → the highest-versionIndex PENDING version
 *                           (awaiting_review: this is the version on screen now;
 *                           decidedAt is null)
 *   no pending, but a
 *   decided version       → the highest-versionIndex NON-superseded version
 *                           (terminal review: the approved/rejected/iterated
 *                           version; carries its decidedAt)
 *   only superseded       → fall back to run.startedAt (transient refresh window
 *                           where the old pending was superseded and the new one
 *                           not yet created — createDocVersion runs after the
 *                           supersede transaction, review.ts:564)
 *
 * versionIndex (1-based, monotone with created_at since both are set together at
 * insert) is the tiebreak key — robust to equal-millisecond created_at across
 * versions and to multiple pending versions on different source ports.
 */
export function deriveReviewRoundTiming(
  run: { startedAt: number | null },
  versionsForRun: readonly ReviewVersionFacts[],
): ReviewRoundTiming | null {
  if (versionsForRun.length === 0) return null
  const pendings = versionsForRun.filter((v) => v.decision === 'pending')
  const pool =
    pendings.length > 0 ? pendings : versionsForRun.filter((v) => v.decision !== 'superseded')
  if (pool.length === 0) {
    // All versions superseded — the brief refresh window. Don't invent a time;
    // fall back to the slot timestamp (frontend then renders started_at).
    return { roundStartedAt: run.startedAt, decidedAt: null }
  }
  const chosen = pool.reduce((a, b) => (b.versionIndex > a.versionIndex ? b : a))
  return { roundStartedAt: chosen.createdAt, decidedAt: chosen.decidedAt }
}

/**
 * Timeline ordering key: review rows sort by their derived round anchor, every
 * other row by its (unchanged) started_at. Never touches started_at itself —
 * only the read-side sort. A null anchor sorts as 0 (matches the old
 * `asc(started_at)` NULL-first behaviour for never-started rows).
 */
export function compareNodeRunsForTimeline(
  a: { id: string; startedAt: number | null; reviewRoundStartedAt?: number | null },
  b: { id: string; startedAt: number | null; reviewRoundStartedAt?: number | null },
): number {
  const ka = a.reviewRoundStartedAt ?? a.startedAt ?? 0
  const kb = b.reviewRoundStartedAt ?? b.startedAt ?? 0
  if (ka !== kb) return ka - kb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
