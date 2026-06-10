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
// Pure module: only the nodeRuns row TYPE is imported (no DB, no scheduler), so
// both functions are trivially unit-testable and there is no import cycle with
// scheduler.ts (which imports from here).

import type { nodeRuns } from '../db/schema'

type NodeRunRow = typeof nodeRuns.$inferSelect

/**
 * Parse `node_runs.consumed_upstream_runs_json` into a `{ upstreamNodeId:
 * nodeRunId }` map. Degrades to `{}` (an empty map ⇒ always fresh) on null,
 * empty string, malformed JSON, non-object shapes, and non-string values —
 * mirroring the migration's hard-cut "null consumed = fresh" rule (design
 * §9.1 / D4) so a legacy or corrupt row never spuriously demotes.
 */
export function parseConsumedJson(json: string | null | undefined): Record<string, string> {
  if (json === null || json === undefined || json === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
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
export function isNodeRunFresh(
  run: NodeRunRow,
  freshestDonePerUpstream: Map<string, NodeRunRow>,
): boolean {
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
