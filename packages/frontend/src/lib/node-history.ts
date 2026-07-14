// Builds the unified "Run history / 运行历史" list shown in the
// NodeDetailDrawer Stats tab.
//
// Background: a single workflow node id may produce many node_runs that
// differ on any of several orthogonal counters — loop `iteration`, RFC-005
// `reviewIteration`, process `retryIndex` — plus the clarify "generation".
// RFC-074 PR-C retired the `clarifyIteration` column; the clarify round is now
// DERIVED from ULID id-order (design §6.5), mirroring the scheduler's canonical
// `priorDoneGenerationsForRun`: the round is the count of prior COMPLETED
// generations — top-level `done` rows of the same node at the same (iteration,
// reviewIteration) minted before this run. This is retry-AGNOSTIC (see
// clarifyRoundForRun for why retryIndex===0 under-counted cross-clarify designer
// reruns). We render one unified, always-visible timeline with the active row
// highlighted.

import type { NodeRun } from '@agent-workflow/shared'

/**
 * All sibling node_runs of the same workflow node, sorted by
 * (iteration, reviewIteration, id). RFC-074 PR-C: ULID id is the canonical
 * creation order, replacing the retired (clarifyIteration, retryIndex,
 * startedAt) tail. *Includes* the current run so the active row can be
 * highlighted in place. Excludes multi-process shard children (they belong to a
 * separate "shards" section above).
 */
export function nodeRunHistory(current: NodeRun, runs: readonly NodeRun[]): NodeRun[] {
  return runs
    .filter((r) => r.nodeId === current.nodeId && r.parentNodeRunId === null)
    .sort((a, b) => {
      if (a.iteration !== b.iteration) return a.iteration - b.iteration
      if (a.reviewIteration !== b.reviewIteration) return a.reviewIteration - b.reviewIteration
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/**
 * RFC-074 PR-C: derive a run's clarify round (the value the retired
 * `clarifyIteration` counter held) from id-order. The round = the number of
 * prior COMPLETED generations: top-level `done` rows for the same node at the
 * same (iteration, reviewIteration, shardKey) whose id is < this run's id.
 * This mirrors the backend's canonical `priorDoneGenerationsForRun` (which
 * scopes on shardKey too) so the chip, the scheduler's `clarifyGeneration`,
 * and `memoryInject`'s anchor all agree. Without the shardKey scope, workgroup
 * member runs — all top-level on the shared `__wg_member__` node, distinguished
 * ONLY by shardKey (assignment id / `msg:*`) — counted each other's parallel
 * assignments as prior "generations" and rendered as spurious 反问#N.
 *
 * It is deliberately retry-AGNOSTIC. A clarify-driven rerun follows the prior
 * generation's `done` row (counted); a process / envelope-followup retry only
 * fires after a `failed` attempt (not counted — same generation). The earlier
 * `retryIndex === 0` filter under-counted cross-clarify DESIGNER reruns, which
 * `triggerDesignerRerun` mints at retryIndex = max+1 (not 0) to keep the
 * scheduler's self-clarify `isClarifyRerun` gate false — so a designer rerun is
 * structurally indistinguishable from a process retry by retryIndex alone.
 * 0 = first generation.
 *
 * Workgroup leader host runs are excluded outright: their successive `done`
 * rows at the same (iteration, shardKey=null) tuple are LEADER ROUNDS minted
 * by the turn machinery (`wg-leader-round`), not clarify generations, and
 * id-order cannot tell the two apart within the null-shard lineage.
 */
export function clarifyRoundForRun(run: NodeRun, runs: readonly NodeRun[]): number {
  if (run.nodeId === '__wg_leader__') return 0
  return runs.filter(
    (r) =>
      r.nodeId === run.nodeId &&
      r.parentNodeRunId === null &&
      r.iteration === run.iteration &&
      r.reviewIteration === run.reviewIteration &&
      (r.shardKey ?? null) === (run.shardKey ?? null) &&
      r.status === 'done' &&
      r.id < run.id,
  ).length
}

/**
 * Derive the RETRY ordinal to display for a run. For regular nodes this is
 * simply `retryIndex` (the scheduler mints process retries with a real
 * per-generation counter). For workgroup HOST runs `retryIndex` is an
 * ordinal, not a retry count — `driveLeaderTurn` mints it as the count of
 * ALL prior leader runs, and message turns count all prior member runs
 * (workgroupRunner.ts) — so a normal second leader turn carries
 * retryIndex=1 with zero retries. For those, derive the real retry count
 * from the lineage instead: prior FAILED top-level runs in the same
 * (nodeId, iteration, reviewIteration, shardKey) tuple minted AFTER the
 * last prior `done` row (a failure belongs to the generation it crashed
 * in; a clarify-answer resume follows a `done` row and is NOT a retry).
 */
export function displayRetryForRun(run: NodeRun, runs: readonly NodeRun[]): number {
  if (run.nodeId !== '__wg_leader__' && run.nodeId !== '__wg_member__') return run.retryIndex
  const lineage = runs.filter(
    (r) =>
      r.nodeId === run.nodeId &&
      r.parentNodeRunId === null &&
      r.iteration === run.iteration &&
      r.reviewIteration === run.reviewIteration &&
      (r.shardKey ?? null) === (run.shardKey ?? null) &&
      r.id < run.id,
  )
  let lastDoneId = ''
  for (const r of lineage) {
    if (r.status === 'done' && r.id > lastDoneId) lastDoneId = r.id
  }
  return lineage.filter((r) => r.status === 'failed' && r.id > lastDoneId).length
}

interface IterationLabelOpts {
  t: (key: string, vars?: Record<string, string | number>) => string
}

/**
 * Joins the non-zero loop / review / clarify counters into a single label.
 * Retry index is appended only when >0 (process retry within that tuple).
 * All-zero tuple → `initial` — the very first attempt, no iteration counter
 * ever bumped.
 *
 * RFC-074 PR-C: the clarify round is no longer read off the row; the caller
 * passes the derived `clarifyRound` (see `clarifyRoundForRun`). The label
 * `iterClarify` covers both self- and cross-clarify flows.
 *
 * `retryOrdinal` overrides the retry suffix; callers with the sibling list
 * pass `displayRetryForRun(run, runs)`. When omitted, workgroup host runs
 * suppress the suffix entirely — their raw `retryIndex` is a turn ordinal
 * (see `displayRetryForRun`), and "领导轮 · 重试#1" on a normal second
 * leader round is a lie. Regular nodes keep the raw `retryIndex`.
 */
export function formatIterationLabel(
  run: NodeRun,
  opts: IterationLabelOpts,
  clarifyRound = 0,
  retryOrdinal?: number,
): string {
  const isWgHost = run.nodeId === '__wg_leader__' || run.nodeId === '__wg_member__'
  const retry = retryOrdinal ?? (isWgHost ? 0 : run.retryIndex)
  const parts: string[] = []
  // RFC-182 P1-3 — workgroup host runs lead with their turn kind (领导轮 /
  // 派发轮 / 被 @ 轮) so the drawer's member-scoped history reads as rounds
  // instead of generic "initial"; the raw shardKey never SURFACES (a prefix
  // check mirrors the backend's shape classifier — impl-gate P2: keying off
  // rerunCause missed clarify-answer reruns, which keep the shard lineage
  // but carry cause='clarify-answer').
  if (run.nodeId === '__wg_leader__') {
    parts.push(opts.t('workgroups.room.turnKindLeader'))
  } else if (run.nodeId === '__wg_member__' && run.shardKey !== null) {
    parts.push(
      run.shardKey.startsWith('msg:')
        ? opts.t('workgroups.room.turnKindMessage')
        : opts.t('workgroups.room.turnKindAssignment'),
    )
  }
  if (run.iteration > 0) parts.push(opts.t('nodeDrawer.iterLoop', { n: run.iteration }))
  if (run.reviewIteration > 0)
    parts.push(opts.t('nodeDrawer.iterReview', { n: run.reviewIteration }))
  if (clarifyRound > 0) parts.push(opts.t('nodeDrawer.iterClarify', { n: clarifyRound }))
  if (parts.length === 0) parts.push(opts.t('nodeDrawer.iterInitial'))
  if (retry > 0) parts.push(opts.t('nodeDrawer.iterRetry', { n: retry }))
  return parts.join(' · ')
}
