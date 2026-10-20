// RFC-161 — task-detail canvas clarify-node click target.
//
// Clicking a clarify / cross-clarify node on the task-status canvas opens the
// clarify page (`/clarify/$nodeRunId`) instead of the (near-empty)
// NodeDetailDrawer. This pure helper picks WHICH node_run to route to — and
// whether the node is clickable at all — from the backend-stamped
// `clarifyNavKind` (services/task.ts getTaskNodeRuns).
//
// All clarify semantics — "has a resolvable round" (never route to a 404),
// awaiting-vs-answered, orphaned-awaiting suppression on a dead task — live in
// the backend oracle. This helper is a PURE freshest-run orchestrator, the same
// shape as deriveReviewNodeNav (review-node-nav.ts): the node's current state is
// its last-minted run; we read that one run's stamp. An OLDER answered/awaiting
// run must NOT shadow a newer non-clickable one (a persistent-stop guard run or a
// canceled round), and a stale orphaned awaiting must NOT be reached past a newer
// null run — freshest-run is immune to both because it only ever reads the current
// run's stamp (design §2.3, resolved across the design-gate rounds).
//
// Unlike deriveReviewNodeNav this does NOT filter to top-level runs: a sharded
// self-clarify's shard sessions are legitimate click targets and may carry a
// parentNodeRunId; the backend clarifyNavKind stamp (null for non-session runs) is
// the safety gate.
//
// Seq-first mint order (later-minted row wins) mirrors the backend's isFresherNodeRun
// comparator; a clarify run's `startedAt` is the createClarifySession mint tick and
// may differ from mint order; the remaining timestamp-first selectors belong to S1b.

import { compareNodeRunMintOrder } from '@agent-workflow/shared'
import type { NodeRun } from '@agent-workflow/shared'

export type ClarifyNodeNavKind = 'awaiting' | 'answered'

export interface ClarifyNodeNav {
  kind: ClarifyNodeNavKind
  /** node_run id to route to: `/clarify/{nodeRunId}`. */
  nodeRunId: string
}

/** last-minted (later-minted) row of a non-empty list. Shared seq-first comparison with a legacy NULL fallback. */
function mintNewest(rows: NodeRun[]): NodeRun {
  let best = rows[0]!
  for (const r of rows) if (compareNodeRunMintOrder(r, best) > 0) best = r
  return best
}

/**
 * The click target for one clarify / cross-clarify workflow node, or null if it
 * should not be clickable. Pure freshest-run: the node's current state is its
 * last-minted run for this nodeId; we read that run's backend stamp.
 *
 * `clarifyNavKind` is matched with strict `===` so an older daemon that never
 * stamped it (undefined) — or a null stamp — collapses to "not clickable" rather
 * than misrouting.
 */
export function deriveClarifyNodeNav(runs: NodeRun[], nodeId: string): ClarifyNodeNav | null {
  const mine = runs.filter((r) => r.nodeId === nodeId)
  if (mine.length === 0) return null
  const freshest = mintNewest(mine)
  if (freshest.clarifyNavKind === 'awaiting') return { kind: 'awaiting', nodeRunId: freshest.id }
  if (freshest.clarifyNavKind === 'answered') return { kind: 'answered', nodeRunId: freshest.id }
  return null
}
