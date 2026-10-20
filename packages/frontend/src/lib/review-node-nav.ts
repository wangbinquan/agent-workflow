// RFC-158 — task-detail canvas review-node click target.
//
// Clicking a review node on the task-status canvas opens the review page
// instead of the (near-empty) NodeDetailDrawer. This pure helper picks WHICH
// node_run to route to, and whether the node is clickable at all, from the
// backend-stamped `reviewNavKind` (services/task.ts getTaskNodeRuns).
//
// All the review-lifecycle semantics — "has a renderable current round"
// (never route to a 404), awaiting-vs-decided, human-vs-system decision — live
// in the backend oracle so they can be tested against real review states and
// stay in lock-step with what `getReviewDetail` renders. This helper is a pure
// mint-order selector over the per-run stamp:
//   1. any top-level run stamped 'awaiting' → open that live review round
//      (U1: at most one awaiting_review per task; newest mint defensively).
//   2. otherwise the last-minted top-level run stamped 'decided' → replay its
//      human conclusion.
//   3. otherwise null (not clickable).
//
// Seq-first mint order (later-minted row wins) mirrors the backend's isFresherNodeRun
// comparator; a review row's `startedAt` is the pinned slot-open tick (RFC-078)
// and is NOT comparable across rounds, so we never sort on it here.

import { compareNodeRunMintOrder } from '@agent-workflow/shared'
import type { NodeRun } from '@agent-workflow/shared'

export type ReviewNodeNavKind = 'awaiting' | 'decided'

export interface ReviewNodeNav {
  kind: ReviewNodeNavKind
  /** node_run id to route to: `/reviews/{nodeRunId}`. */
  nodeRunId: string
}

/** Last-minted row of a non-empty list. Shared seq-first comparison with a legacy NULL fallback. */
function mintNewest(rows: NodeRun[]): NodeRun {
  let best = rows[0]!
  for (const r of rows) if (compareNodeRunMintOrder(r, best) > 0) best = r
  return best
}

/**
 * The click target for one review workflow node, or null if it should not be
 * clickable. Considers only the node's top-level runs (fan-out shard children
 * — parentNodeRunId set — are skipped; per-shard review is RFC-005 T14).
 *
 * The node's CURRENT state is its FRESHEST (last-minted) top-level run — the
 * same later-minted-row-wins rule the backend / canvas status use. We read that
 * one run's stamp; an OLDER decided run must NOT shadow a newer non-clickable
 * one. Concretely, the R3 re-park-then-supersede state stamps the current run
 * null (its current version is a fresh pending), and this node must be
 * un-clickable even though an older run of the same node was a human conclusion
 * — otherwise the canvas would route to a stale, superseded conclusion.
 *
 * When an awaiting run and a decided run coexist for one node, the awaiting run
 * is always the fresher (a re-review is minted AFTER the prior decision), so
 * "freshest wins" naturally prefers the live round without a special case.
 *
 * `reviewNavKind` is matched with strict `===` so an older daemon that never
 * stamped it (undefined) collapses to "not clickable" rather than misrouting.
 */
export function deriveReviewNodeNav(runs: NodeRun[], nodeId: string): ReviewNodeNav | null {
  const topLevel = runs.filter((r) => r.nodeId === nodeId && r.parentNodeRunId === null)
  if (topLevel.length === 0) return null
  const freshest = mintNewest(topLevel)
  if (freshest.reviewNavKind === 'awaiting') return { kind: 'awaiting', nodeRunId: freshest.id }
  if (freshest.reviewNavKind === 'decided') return { kind: 'decided', nodeRunId: freshest.id }
  return null
}
