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

/**
 * Order two node_run rows by "freshness". The freshest row drives the node's
 * state in the scheduler (latestPerNode) and every shared picker below.
 *
 * RFC-074 PR-C: pure ULID-id ordering. The newest-inserted row always wins.
 * RFC-096 (audit S-13 / WP-3): moved here from scheduler.ts — the ordering
 * authority lives with the freshness primitives; the generic is widened to
 * `{ id: string }` (only the id is compared) so projected row shapes (e.g.
 * lifecycleRepair's RepairNodeRunRow) can use it too.
 *
 * Why pure id is correct (and why the old `(clarifyIteration, retryIndex, id)`
 * triple is gone):
 *   - node_run ids are ULIDs, monotonically increasing in creation order. Every
 *     rerun that should "win" — a clarify-driven rerun, a cross-clarify rerun,
 *     a single-node process retry — is by construction minted AFTER the rows it
 *     supersedes, so it always has the largest id.
 *   - `(retryIndex, id)` was considered and rejected: a retry storm on a stale
 *     row could inflate retryIndex above a later low-retry clarify rerun and
 *     wrongly shadow it. Pure id has no such failure mode.
 *
 * The PR-A baseline suite (`isfresher-noderun-baseline.test.ts`) locks that
 * this ordering is byte-equivalent to the retired triple on causally-minted
 * rows; the C-group adds the id-equivalence cross-check.
 */
export function isFresherNodeRun<R extends { id: string }>(
  candidate: R,
  incumbent: R | undefined,
): boolean {
  if (incumbent === undefined) return true
  return candidate.id > incumbent.id
}

/**
 * RFC-098 B3 (audit S-7,「freshest-run 抽一次别 fork」第二缝) — the ONE
 * sanctioned iteration-window source picker, extracted verbatim from
 * resolveUpstreamInputs (scheduler.ts) so wrapper-consumed computation uses
 * the EXACT same口径 as the agent input read-point. Among top-level DONE rows
 * whose iteration ≤ `iterationWindow`, pick the highest iteration
 * (cross-boundary "latest visible", e.g. git-wrapper / loop carry) and,
 * within that iteration, the freshest by isFresherNodeRun (pure ULID order).
 *
 * NOT the same as pickFreshestRun: that picker is pure-id-ordered with no
 * iteration term and no window — using it for source resolution would let a
 * later-minted row at a HIGHER iteration win even outside the caller's
 * visibility window. Two distinct contracts, both living here so neither
 * gets forked.
 */
export function pickUpstreamSourceRun<
  R extends { id: string; iteration: number; parentNodeRunId: string | null; status: string },
>(rows: readonly R[], iterationWindow: number): R | undefined {
  let run: R | undefined
  for (const r of rows) {
    if (r.iteration > iterationWindow) continue
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'done') continue
    if (run === undefined) {
      run = r
      continue
    }
    if (r.iteration > run.iteration) {
      run = r
      continue
    }
    if (r.iteration === run.iteration && isFresherNodeRun(r, run)) run = r
  }
  return run
}

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
 * RFC-098 B3 (audit S-19/S-20/S-21,「freshest-run 抽一次别 fork」缝) — the ONE
 * sanctioned picker for a REUSABLE fanout shard row. Shared by
 * dispatchFanoutShard (cross-generation done-shard replay) and
 * dispatchFanoutAggregator (per-shardKey aggregation input pick), so the two
 * sites can never drift apart. Contract:
 *
 *   - rows: candidate rows already anchored by the caller's SQL WHERE
 *     `(taskId, nodeId, iteration, parentNodeRunId IS NOT NULL)` — the
 *     non-null parent keeps frontier invisibility intact AND excludes the
 *     top-level inert placeholder rows retryNode mints for inner nodes.
 *   - shardKey match: `(row.shardKey ?? null) === shardKey` (null = the
 *     shared/broadcast row or the aggregator row).
 *   - done-only: a non-done row is never reusable (its outputs are absent
 *     or superseded); non-done handling (in-place re-run vs fresh mint) is
 *     the caller's branch, not this picker's.
 *   - hash policy NULL = MATCH (legacy compatibility — hard requirement):
 *     a row minted before migration 0043 carries shardValueHash NULL and must
 *     stay reusable (scheduler-boundary-fanout-resume-duplicate-shards +
 *     scheduler-audit-s21 test 1 pre-seed hashless done children and assert
 *     zero re-spawn). Symmetrically a NULL `valueHash` (shared row / caller
 *     without a value) matches any stored hash.
 *   - freshest wins: among the surviving rows, pure ULID order
 *     (isFresherNodeRun).
 */
export function pickReusableShardRun<
  R extends { id: string; status: string; shardKey: string | null; shardValueHash: string | null },
>(rows: readonly R[], opts: { shardKey: string | null; valueHash: string | null }): R | undefined {
  let best: R | undefined
  for (const r of rows) {
    if ((r.shardKey ?? null) !== opts.shardKey) continue
    if (r.status !== 'done') continue
    if (r.shardValueHash !== null && opts.valueHash !== null && r.shardValueHash !== opts.valueHash)
      continue
    if (isFresherNodeRun(r, best)) best = r
  }
  return best
}

/**
 * RFC-074 §3.2 / §4.2: each in-scope node's freshest DONE top-level row at the
 * given scope iteration, keyed by nodeId. This is the map `isNodeRunFresh`
 * consults — a consumed upstream run is "still fresh" iff it equals the id of
 * that upstream's entry here. (RFC-096: moved here from scheduler.ts.)
 */
export function buildFreshestDonePerNode(
  rows: ReadonlyArray<NodeRunRow>,
  scopeIds: Set<string>,
  iteration: number,
): Map<string, NodeRunRow> {
  const m = new Map<string, NodeRunRow>()
  for (const r of rows) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'done') continue
    if (isFresherNodeRun(r, m.get(r.nodeId))) m.set(r.nodeId, r)
  }
  return m
}

/**
 * RFC-096 (audit S-13 / WP-3) — the ONE sanctioned way to pick "the freshest
 * run" out of a row set. Ordering is always pure ULID id (isFresherNodeRun);
 * the only knobs are explicit filter predicates. nodeId / iteration filtering
 * belongs in the caller's SQL WHERE — this picker deliberately does not group.
 *
 * History this replaces: `desc(retryIndex)` picks (a retry storm on a stale
 * row shadows a later low-retry rerun — the bug resumeTask fixed once already)
 * and `desc(startedAt)` picks (NULL startedAt sorts LAST under DESC, so
 * freshly-minted rerun rows — which never write startedAt — could never be
 * selected; mark-running rewrites startedAt and made the order drift).
 */
export function pickFreshestRun<
  R extends { id: string; parentNodeRunId: string | null; status: string },
>(
  rows: readonly R[],
  opts: { topLevelOnly?: boolean; statusIn?: readonly string[] } = {},
): R | undefined {
  const topLevelOnly = opts.topLevelOnly ?? true
  let best: R | undefined
  for (const r of rows) {
    if (topLevelOnly && r.parentNodeRunId !== null) continue
    if (opts.statusIn !== undefined && !opts.statusIn.includes(r.status)) continue
    if (isFresherNodeRun(r, best)) best = r
  }
  return best
}
