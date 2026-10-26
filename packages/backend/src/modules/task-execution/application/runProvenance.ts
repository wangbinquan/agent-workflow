// RFC-074 — provenance-based node freshness (PR-B).
//
// Replaces the scalar `clarify_iteration` (cci) watermark. A node_run records
// `consumed_upstream_runs_json = { upstreamNodeId: nodeRunId }` at its single
// content read-point (resolveUpstreamInputs for agents, sourceRun for review
// nodes). The node is "fresh" iff every upstream run it consumed is STILL the
// freshest done row of that upstream — computed read-time here, replacing the
// two speculative-mint cascade layers (cascadeDownstreamFromDesigner +
// applyClarifyFreshnessInvariant).
//
// Pure legacy compatibility primitive: it owns a structural row projection
// and has no DB or scheduler dependency.

import type { NodeRunOrderKey, NodeRunStatus } from '@agent-workflow/shared'
import { parseConsumedJson } from '../domain/consumedInputs'
import { createRunHistorySnapshot } from './runHistory'
export { parseConsumedJson } from '../domain/consumedInputs'

/**
 * RFC-311 — the freshness/frontier column contract. Narrowed from the full
 * row so the scheduler's per-tick query (and the dispatch ledger's four
 * per-task fetches) can project away prompt_text + the iso/inventory JSON
 * columns; the compiler points here the moment a frontier consumer starts
 * needing a column the projections do not carry.
 */
export interface NodeRunRow extends NodeRunOrderKey {
  readonly id: string
  readonly nodeId: string
  readonly status: NodeRunStatus
  readonly iteration: number
  readonly parentNodeRunId: string | null
  /** RFC-354 — the frame (wrapper generation row) this row hangs off; null at the top scope. */
  readonly containerRunId: string | null
  readonly mergeState: string | null
  readonly shardKey: string | null
  readonly consumedUpstreamRunsJson: string | null
  readonly supersededByReview: string | null
  /** Wrapper progress snapshot; non-null only for wrapper rows. */
  readonly wrapperProgressJson: string | null
}

/**
 * Read-time freshness check (design §4.1). A run is fresh iff every upstream
 * run it consumed is still the freshest done row of that upstream within the
 * relevant iteration scope.
 *
 * @param run the node_run whose freshness we're judging
 * @param freshestDonePerUpstream map: upstreamNodeId → that upstream's freshest
 *   done top-level run in the current scope iteration (§3.2). An upstream
 *   ABSENT from the map (no done row at this scope, e.g. a settled cross-loop
 *   boundary input) is treated as still-fresh — we never demote on the basis
 *   of an upstream that has no current-scope done row (defensive).
 */
export async function isNodeRunFresh(
  run: NodeRunRow,
  freshestDonePerUpstream: ReadonlyMap<string, NodeRunRow>,
): Promise<boolean> {
  const consumed = parseConsumedJson(run.consumedUpstreamRunsJson)
  for (const [upId, consumedId] of Object.entries(consumed)) {
    const cur = freshestDonePerUpstream.get(upId)
    if (cur === undefined) continue // upstream has no current-scope done row → not stale
    if (cur.id !== consumedId) return false // upstream produced a newer done row → stale
  }
  return true
}

/**
 * RFC-074 follow-up — transitive dispatch gate. Incident replay: task
 * 01KT1HDYV6RA8EJGY5BSE20MH9 (same graph shape as 01KS86DPCSERV7S41GQA5Y81RN —
 * in → designer → rev1 → questioner → rev2 → out + cross-clarify cycle).
 *
 * A node is dispatch-ready iff EVERY *transitive* structural upstream is
 * `completed` (the scheduler's live "latest run is done ∧ one-hop-fresh" set),
 * not merely its DIRECT upstreams. runScope historically gated on direct
 * upstreams only (`ups.every((u) => completed.has(u))`). When a cross-clarify
 * answer re-ran the GRANDPARENT designer out-of-band, the intermediate review
 * node still showed its stale `done` row — one-hop-fresh, not yet demoted — so
 * `completed.has(review)` was true and the grandchild questioner dispatched in
 * the SAME batch, 198ms after the designer rerun finished, consuming an
 * approved_doc that no longer matched the revised design. It thus raced ahead of
 * the re-review the rerun should have forced (rev1 was only demoted to
 * awaiting_review AFTER the questioner had already run). Walking the whole
 * ancestor chain closes that window: the grandchild waits until its entire
 * chain has re-settled (i.e. the review is re-approved).
 *
 * Pure graph predicate — no db / scheduler / nodeRuns dependency, preserving
 * this module's purity contract. `seen` memoizes already-confirmed subtrees and
 * makes the walk cycle-safe (defensive: buildScopeUpstreams already drops the
 * channel / back edges — __clarify__, __clarify_response__, __external_feedback__,
 * to_designer, to_questioner — so the structural DAG is acyclic).
 */
export function areTransitiveUpstreamsCompleted(
  nodeId: string,
  upstreamsOf: Map<string, string[]>,
  completed: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): boolean {
  for (const u of upstreamsOf.get(nodeId) ?? []) {
    if (!completed.has(u)) return false
    if (seen.has(u)) continue // subtree already confirmed (memo + cycle guard)
    seen.add(u)
    if (!areTransitiveUpstreamsCompleted(u, upstreamsOf, completed, seen)) return false
  }
  return true
}

/**
 * Pure extraction of the per-batch ready computation, so the transitive
 * gate above is unit-testable at the actual dispatch-decision altitude (rather
 * than only as graph-walk trivia). A remaining node becomes ready only once its
 * whole structural ancestor chain is `completed`. Generic over the node shape —
 * tests pass `{ id }` stubs.
 *
 * Status (RFC-094, audit S-26): production dispatch moved to deriveFrontier
 * (scheduler.ts), which inlines this readiness step via
 * areTransitiveUpstreamsCompleted. This wrapper is kept as the TEST ORACLE for
 * the transitive gate (scheduler-transitive-dispatch-gate.test.ts) — do not
 * delete without migrating that lock.
 */
export function computeReadyNodes<N extends { id: string }>(
  remaining: Iterable<N>,
  upstreamsOf: Map<string, string[]>,
  completed: ReadonlySet<string>,
): N[] {
  const ready: N[] = []
  for (const n of remaining) {
    if (areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) ready.push(n)
  }
  return ready
}

/**
 * Pick the freshest top-level row visible to a consumer iteration, regardless
 * of status. Highest visible iteration wins, then mint seq order. Review
 * dispatch uses this form so a newer pending/failed row fails loudly instead
 * of silently falling back to an older done document; ordinary data inputs use
 * the done-only shell above.
 */
/**
 * RFC-098 B3 (audit S-20) — strict equality of two consumed-provenance maps
 * (`{ upstreamNodeId: nodeRunId }`). Used by the fanout wrapper's consumed
 * GENERATION GATE: the previously recorded map and the freshly resolved one
 * must be identical for done-shard reuse to stay enabled — any difference
 * (an upstream re-ran, an upstream appeared/disappeared) means the prior
 * generation's shard results may be stale in ways the per-shard value hash
 * cannot see (path-family shard values are bare path strings). Key ORDER is
 * irrelevant; key SET and every value must match.
 */
export function consumedMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/**
 * RFC-074 §3.2 / §4.2: each in-scope node's freshest SETTLED top-level row at
 * the given scope iteration, keyed by nodeId. This is the map `isNodeRunFresh`
 * consults — a consumed upstream run is "still fresh" iff it equals the id of
 * that upstream's entry here. (RFC-096: moved here from scheduler.ts;
 * RFC-306 widened "settled" from done-only to done ∪ skipped and renamed it
 * from buildFreshestDonePerNode — no alias is kept, so any missed call site is
 * a compile error rather than a silently done-only read.)
 */
export async function buildFreshestSettledPerNode(
  rows: ReadonlyArray<NodeRunRow>,
  scopeIds: ReadonlySet<string>,
  // RFC-354 — one frame: the wrapper generation row (null at the top) + round.
  frame: { readonly containerRunId: string | null; readonly iteration: number },
): Promise<ReadonlyMap<string, NodeRunRow>> {
  const selection = createRunHistorySnapshot('', rows)
  const m = new Map<string, NodeRunRow>()
  for (const nodeId of new Set(
    rows
      .filter(
        (row) =>
          scopeIds.has(row.nodeId) &&
          row.parentNodeRunId === null &&
          (row.containerRunId ?? null) === frame.containerRunId &&
          row.iteration === frame.iteration &&
          (row.status === 'done' || row.status === 'skipped'),
      )
      .map((row) => row.nodeId),
  )) {
    const selected = (
      await selection.familyHistory(
        '',
        {
          nodeId,
          iteration: frame.iteration,
          containerRunId: frame.containerRunId,
          parentNodeRunId: null,
        },
        { statusIn: ['done', 'skipped'] },
      )
    ).at(-1)
    const row = rows.find((row) => row.id === selected?.id)
    if (row !== undefined) m.set(nodeId, row)
  }
  return m
}
