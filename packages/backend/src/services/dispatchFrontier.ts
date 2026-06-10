// RFC-076 PR-A — trim-B dispatch predicates (PURE; LIVE since PR-B wired
// deriveFrontier into runScope — scheduler.ts consumes isDispatchable every
// dispatch tick; RFC-094 removed the stale "currently UNWIRED" claim that
// post-dated the wiring, audit S-26).
//
// These are the two NOVEL predicates the dispatch frontier needs, on top
// of fix A's computeReadyNodes / areTransitiveUpstreamsCompleted (freshness.ts).
// They are the much-reviewed (3 adversarial rounds) corrections to the original
// full-B sketch:
//
//   - isDispatchable(latestRow, kind, …) — the per-node status gate. The crux
//     (round-2 N1): `failed`/`interrupted` MUST be dispatchable — they are the
//     resume / retry / daemon-restart re-mint signal (resumeTask leaves the
//     failed row and lets the scheduler mint retry_index=max+1; reapOrphanRuns
//     flips running→interrupted). Excluding them — as full-B did — would turn
//     every resume into "scheduler stalled". `exhausted` (loop-max, a true
//     terminal, round-3 HIGH-2) is NOT dispatchable. A FRESH leaf `awaiting_*`
//     stays parked (round-1 C2 busy-loop fix); a STALE one (upstream advanced)
//     re-dispatches like a stale `done` (S8/S11/S12 — re-park the review against
//     the fresh upstream). A WRAPPER's `awaiting_*` IS dispatchable (round-2 N2
//     resume anchor), but only when its inner scope has fresh post-answer work.
//
//   - wrapperHasFreshInnerWork(wrapperRow, rows, definition) — round-3 HIGH-1.
//     A wrapper-loop parks its OWN top-level row at `parentIteration`, but its
//     inner descendants (and the clarify/review rerun minted on answer) live at
//     the loop counter `i`. Scanning the wrapper's own iteration would miss the
//     i≥1 rerun → the answered task would re-park forever ("scheduler stalled").
//     So the scan window comes from the wrapper PROGRESS payload's iteration for
//     loops, and from the wrapper row's own iteration for git wrappers (git
//     inner shares the wrapper iteration).
//
// PURE module: only types + isNodeRunFresh (freshness.ts) + decodeWrapperProgress
// (wrapperProgress.ts, itself pure). No DB / scheduler import. The frontier
// ORCHESTRATION (read rows → latestPerNode → freshestDone → completed → ready)
// lives in scheduler.ts deriveFrontier (PR-B, live) next to the row-ordering
// primitives (isFresherNodeRun / buildFreshestDonePerNode). Pure-function locks:
// dispatch-frontier.test.ts + derive-frontier.test.ts.

import type { NodeKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { nodeRuns } from '../db/schema'
import { isNodeRunFresh } from './freshness'
import { decodeWrapperProgress } from './wrapperProgress'

type NodeRunRow = typeof nodeRuns.$inferSelect

const WRAPPER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'wrapper-loop',
  'wrapper-git',
  'wrapper-fanout',
])

/** Safe read of a wrapper node's inner `nodeIds` (absent / non-array → []). */
function innerNodeIdsOf(node: WorkflowNode | undefined): string[] {
  const raw = (node as { nodeIds?: unknown } | undefined)?.nodeIds
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * All transitive inner-descendant node ids of a wrapper (direct inner +
 * recursively the inner of any nested wrapper). Cycle-safe via `visiting`
 * (definitions are acyclic containment trees, but guard defensively). G6.
 */
export function wrapperInnerDescendants(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
  acc: Set<string> = new Set(),
  visiting: Set<string> = new Set(),
): Set<string> {
  if (visiting.has(wrapperNodeId)) return acc
  visiting.add(wrapperNodeId)
  const node = definition.nodes.find((n) => n.id === wrapperNodeId)
  for (const id of innerNodeIdsOf(node)) {
    acc.add(id)
    wrapperInnerDescendants(id, definition, acc, visiting)
  }
  return acc
}

/**
 * RFC-076 round-3 HIGH-1. Does a parked wrapper's inner scope hold fresh
 * post-answer work (a `pending` row minted by submitClarifyAnswers /
 * submitReviewDecision while the wrapper was suspended)? Scans inner-descendant
 * rows AT THE CORRECT ITERATION WINDOW:
 *   - wrapper-loop: the loop counter from the wrapper's progress payload (the
 *     iteration the inner scope parked on). Malformed/absent → 0 (mirrors the
 *     runtime resume fallback `startIter=0`). NOT the wrapper row's own
 *     iteration (which is the parent scope's iteration — would miss i≥1 work).
 *   - wrapper-git: the wrapper row's own iteration (git inner shares it).
 */
export function wrapperHasFreshInnerWork(
  wrapperRow: NodeRunRow,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  const node = definition.nodes.find((n) => n.id === wrapperRow.nodeId)
  const kind = node?.kind
  let innerIter: number
  if (kind === 'wrapper-loop') {
    const progress = decodeWrapperProgress(wrapperRow.wrapperProgressJson, () => {})
    innerIter = progress?.iteration ?? 0
  } else {
    // wrapper-git (and any non-loop wrapper): inner shares the wrapper iteration.
    innerIter = wrapperRow.iteration
  }
  const inner = wrapperInnerDescendants(wrapperRow.nodeId, definition)
  return rows.some(
    (r) => inner.has(r.nodeId) && r.iteration === innerIter && r.status === 'pending',
  )
}

/**
 * RFC-076 trim-B per-node dispatch gate. Given a node's LATEST top-level run
 * row (or undefined if it never ran), its workflow kind, the current
 * freshest-done map, and the full row set + definition (for the wrapper
 * carve-out), decide whether the node may be (re-)dispatched.
 *
 *   undefined            → true   (never ran)
 *   pending              → true   (out-of-band mint / placeholder)
 *   done ∧ !fresh        → true   (stale-done re-run; fix A multi-hop demote)
 *   failed | interrupted → true   (resume / retry re-mint signal — N1; the
 *                                  scheduler mints retry_index=max+1, bounded by
 *                                  runOneNode's attempt ≤ retryIndex+maxRetries)
 *   wrapper awaiting_*   → wrapperHasFreshInnerWork (N2 resume anchor + HIGH-1)
 *   leaf awaiting_*      → !fresh (stale parked re-runs; fresh parked stays — C2)
 *   else                 → false  (done∧fresh / exhausted [loop-max true
 *                                  terminal, HIGH-2] / canceled / running)
 *
 * In-pass busy-loop protection does NOT come from this gate — it comes from the
 * scheduler's per-invocation `dispatchedThisInvocation` set (N3) + runOneNode
 * minting a `pending` row on dispatch. This gate only decides eligibility.
 */
export function isDispatchable(
  row: NodeRunRow | undefined,
  kind: NodeKind,
  freshestDonePerUpstream: Map<string, NodeRunRow>,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  if (row === undefined) return true
  if (row.status === 'pending') return true
  if (row.status === 'done') return !isNodeRunFresh(row, freshestDonePerUpstream)
  if (row.status === 'failed' || row.status === 'interrupted') return true
  if (row.status === 'awaiting_human' || row.status === 'awaiting_review') {
    if (WRAPPER_KINDS.has(kind)) return wrapperHasFreshInnerWork(row, rows, definition)
    // Leaf parked (review / clarify). C2 keeps a FRESH parked leaf parked — it
    // is genuinely waiting on a human, and re-dispatching it every tick would
    // busy-loop. But a parked leaf whose consumed upstream has since advanced is
    // STALE: the artifact under review changed out from under the pending human
    // decision. It must re-dispatch (re-park a fresh review against the new
    // upstream), exactly like a stale `done` row — symmetric with the line
    // above. Approving a stale parked review would otherwise leave it consuming
    // an obsolete upstream run, surfacing as a spurious re-review on the next
    // scope entry (the RFC-074 demote-the-stale-parked-review path the old batch
    // model performed via recomputeFreshnessAndDemote; combination-scenarios
    // S8/S11/S12 lock this). `dispatchedThisInvocation` (N3) still bounds it to
    // one re-dispatch per invocation, so no busy-loop.
    return !isNodeRunFresh(row, freshestDonePerUpstream)
  }
  // exhausted (loop-max true terminal) / canceled / running → not dispatchable
  return false
}
