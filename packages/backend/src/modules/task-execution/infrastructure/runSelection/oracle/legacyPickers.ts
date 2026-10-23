// RFC-395 II-a A3：旧选择规则仅由 oracle 持有；包括 NULL seq 与 ID 回退。
import { isNewerNodeRun, type NodeRunOrderKey } from '@agent-workflow/shared'

/** RFC-374: shared seq-first mint order; NULL legacy rows retain their ID order. */
export function isFresherNodeRun<R extends NodeRunOrderKey>(
  candidate: R,
  incumbent: R | undefined,
): boolean {
  return isNewerNodeRun(candidate, incumbent)
}

// RFC-354 retired `pickUpstreamSourceRun` / `pickVisibleUpstreamRun` — the
// RFC-098 B3 "iteration ≤ window, highest wins" cross-boundary carry. It only
// coincided with lexical scoping for one loop level (audit S-6: a nested
// loop's body read the wrong generation). A source in an enclosing scope is
// now reached by resolving its FRAME first (task-execution/domain/
// environmentChain) and reading inside that frame (`pickFrameSourceRun`);
// nothing leaks across rounds or generations.

/**
 * RFC-354 — the freshest SETTLED top-level row of a node across ALL frames:
 * the read a task-boundary projection needs (a child task's output nodes
 * feeding a parent `call-workflow`), where the caller is outside every frame
 * of the task and "the task's answer" is simply its latest settled row.
 * Everything inside a task reads by frame (`pickFrameSourceRun`).
 */
export function pickLatestSettledRun<
  R extends NodeRunOrderKey & { id: string; parentNodeRunId: string | null; status: string },
>(rows: readonly R[]): R | undefined {
  let run: R | undefined
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    if (!isSettledRunStatus(r)) continue
    if (isFresherNodeRun(r, run)) run = r
  }
  return run
}

/**
 * RFC-354 — the LATEST top-level row of a node inside one frame, any status.
 * For readers that must judge the freshest row themselves (the review
 * dispatch fails loudly with `review-upstream-not-done` when the newest row
 * is not done, instead of silently reading an older done row).
 */
export function pickLatestRunInFrame<
  R extends NodeRunOrderKey & {
    id: string
    iteration: number
    parentNodeRunId: string | null
    containerRunId: string | null
  },
>(rows: readonly R[], frame: { containerRunId: string | null; iteration: number }): R | undefined {
  let run: R | undefined
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    if ((r.containerRunId ?? null) !== frame.containerRunId || r.iteration !== frame.iteration) {
      continue
    }
    if (isFresherNodeRun(r, run)) run = r
  }
  return run
}

/**
 * RFC-354 — the frame-level source picker that replaces the iteration window
 * above. A consumer reads an upstream inside exactly ONE frame
 * `(containerRunId, iteration)` — its own frame for a local variable, or the
 * frame `resolveSourceFrame` (task-execution/domain/environmentChain) walked
 * to for a captured free variable / wrapper parameter. Within that frame the
 * answer is the freshest SETTLED (done ∪ skipped, RFC-306) top-level row by
 * mint seq order. There is deliberately no fallback to an earlier round or a
 * neighbouring container: a value that is not in the environment is not a
 * value, and the caller surfaces `closure-binding-unresolved`.
 *
 * Lives next to pickUpstreamSourceRun on purpose (audit S-7: one home for
 * pickers, no forks); the window picker is retired once every call site has
 * moved to frames.
 */
export function pickFrameSourceRun<
  R extends NodeRunOrderKey & {
    id: string
    iteration: number
    parentNodeRunId: string | null
    containerRunId: string | null
    status: string
  },
>(rows: readonly R[], frame: { containerRunId: string | null; iteration: number }): R | undefined {
  let run: R | undefined
  for (const r of rows) {
    if (r.parentNodeRunId !== null) continue
    if ((r.containerRunId ?? null) !== frame.containerRunId || r.iteration !== frame.iteration) {
      continue
    }
    if (!isSettledRunStatus(r)) continue
    if (isFresherNodeRun(r, run)) run = r
  }
  return run
}

/**
 * RFC-306 — the SETTLED set: `done` ∪ `skipped`.
 *
 * Before RFC-306 the pickers were done-only, which was the same thing: nothing
 * ever minted a `skipped` row. Now a node that a closed branch bypassed settles
 * as `skipped`, and every "what is this upstream's current answer?" read must
 * see that row — otherwise the picker walks PAST it to an older `done` row and
 * hands downstream the output of a generation the branch decision has since
 * superseded. Concretely: run 1 emits `need_fix`, run 2 (after the user retried
 * the judge) closes that branch, and a done-only picker would keep feeding
 * run 1's findings into the fixer that RFC-306 just decided must not run.
 *
 * Skipped rows carry no `node_run_outputs`, so a consumer that picks one reads
 * empty content — which is exactly right: the branch produced nothing.
 */
export function isSettledRunStatus(row: { status: string }): boolean {
  return row.status === 'done' || row.status === 'skipped'
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
 *   - freshest wins: among the surviving rows, mint seq order
 *     (isFresherNodeRun).
 */
export function pickReusableShardRun<
  R extends NodeRunOrderKey & {
    id: string
    status: string
    shardKey: string | null
    shardValueHash: string | null
  },
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
 * RFC-096 (audit S-13 / WP-3) — the ONE sanctioned way to pick "the freshest
 * run" out of a row set. Ordering is always mint seq (isFresherNodeRun);
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
  R extends NodeRunOrderKey & { id: string; parentNodeRunId: string | null; status: string },
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
