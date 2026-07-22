// RFC-202 T2 — terminal-task sweep: seal every open human gate (clarify
// rounds / review parks) of a task that reached an UNREVIVABLE terminal
// status (done / canceled).
//
// Why: the 2026-07-16 UX audit (design/ux-functional-audit-2026-07-16.md §1
// R8) found dead tasks' clarify rounds and review parks lingering forever in
// the inbox / badges as「待回答 / 待评审」— answering was pointless (or worse,
// the answer committed and then errored). cancelTaskRow / failTask only flip
// the TASK row; the gate rows stayed awaiting (services/task.ts documents the
// per-view suppression patches this replaces at the source).
//
// Semantics (design.md §1):
//   - HARD seal only for done/canceled — failed/interrupted tasks are
//     revivable (resume allowedFrom includes them), their gates are hidden by
//     the read-path terminal filter (T6) instead and reappear on resume.
//   - clarify rounds seal BY KIND: self → 'canceled'; cross → 'abandoned'
//     (+ abandonedAt). Migration 0031's CHECK enforces exactly this split —
//     writing 'canceled' to a cross round would roll back the whole sweep.
//   - review: awaiting_review node_runs → canceled. doc_versions stay
//     'pending' on purpose: listReviewSummaries' pending predicate is bound
//     to the RUN status, and the decision audit trail must not be forged.
//
// Wiring: registered as the lifecycle terminal-task hook at daemon assembly
// (cli/start.ts) — lifecycle.ts cannot import this module directly (cycle).
// The workgroup autonomous-flip dismissal (workgroupLifecycle.ts) stays a
// separate NARROW implementation on purpose: it runs on a LIVE task, must
// not touch review/completion gates, and needs its assignment requeue inside
// the same transaction (Codex design-gate P1).

import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { clarifyRounds, nodeRuns } from '@/db/schema'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { createLogger } from '@/util/log'

const log = createLogger('terminal-sweep')

export interface TerminalSweepResult {
  sealedSelfRounds: number
  abandonedCrossRounds: number
  canceledRuns: { nodeRunId: string; nodeId: string }[]
}

/**
 * Seal all open human gates of `taskId` in ONE synchronous transaction.
 * Idempotent: every UPDATE is guarded on the awaiting status, so re-running
 * on an already-swept task is a no-op.
 */
export function sealOpenHumanGatesForTask(
  db: DbClient,
  taskId: string,
  cause: string,
): TerminalSweepResult {
  const result: TerminalSweepResult = {
    sealedSelfRounds: 0,
    abandonedCrossRounds: 0,
    canceledRuns: [],
  }
  const now = Date.now()
  dbTxSync(db, (tx) => {
    // 1) Legacy self-clarify session rows (clarify_sessions is still the
    //    read model for parts of the self flow).
    // 2) Authoritative clarify rounds, split by kind (migration 0031 CHECK:
    //    self never 'abandoned', cross never 'canceled').
    const openRounds = tx
      .select({
        id: clarifyRounds.id,
        kind: clarifyRounds.kind,
        intermediaryNodeId: clarifyRounds.intermediaryNodeId,
        intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
      })
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.status, 'awaiting_human')))
      .all()
    for (const r of openRounds) {
      if (r.kind === 'cross') {
        tx.update(clarifyRounds)
          .set({ status: 'abandoned', abandonedAt: now })
          .where(and(eq(clarifyRounds.id, r.id), eq(clarifyRounds.status, 'awaiting_human')))
          .run()
        result.abandonedCrossRounds++
      } else {
        tx.update(clarifyRounds)
          .set({ status: 'canceled' })
          .where(and(eq(clarifyRounds.id, r.id), eq(clarifyRounds.status, 'awaiting_human')))
          .run()
        result.sealedSelfRounds++
      }
      // Park-carrier run for this round (self: the clarify intermediary;
      // cross: the questioner's run). Same-tx guarded write — the shared
      // transition table's `mark-canceled` edge covers awaiting_human, and
      // async lifecycle helpers cannot join a sync transaction.
      // rfc053-allow-direct-status-write -- RFC-202 T2 atomic terminal sweep
      const parked = tx
        .update(nodeRuns)
        .set({ status: 'canceled', finishedAt: now, errorMessage: cause })
        .where(and(eq(nodeRuns.id, r.intermediaryNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
        .returning({ id: nodeRuns.id })
        .all()
      if (parked.length > 0) {
        result.canceledRuns.push({
          nodeRunId: r.intermediaryNodeRunId,
          nodeId: r.intermediaryNodeId,
        })
      }
    }
    // 3) Legacy cross session rows (RFC-056 read model).
    // 4) Any remaining awaiting_human node_runs the round rows didn't cover
    //    (defensive: legacy rows without a round), and review parks. The
    //    shared table's `mark-canceled` edge covers both awaiting statuses.
    // rfc053-allow-direct-status-write -- RFC-202 T2 atomic terminal sweep
    const strays = tx
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: now, errorMessage: cause })
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'awaiting_human')))
      .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
      .all()
    for (const s of strays) result.canceledRuns.push({ nodeRunId: s.id, nodeId: s.nodeId })
    // rfc053-allow-direct-status-write -- RFC-202 T2 atomic terminal sweep
    const reviews = tx
      .update(nodeRuns)
      .set({ status: 'canceled', finishedAt: now, errorMessage: cause })
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'awaiting_review')))
      .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
      .all()
    for (const s of reviews) result.canceledRuns.push({ nodeRunId: s.id, nodeId: s.nodeId })
  })
  for (const r of result.canceledRuns) {
    taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: r.nodeRunId,
      nodeId: r.nodeId,
      status: 'canceled',
    })
  }
  if (
    result.sealedSelfRounds > 0 ||
    result.abandonedCrossRounds > 0 ||
    result.canceledRuns.length > 0
  ) {
    log.info(
      `sealed open human gates for terminal task ${taskId} (cause=${cause}): ` +
        `${result.sealedSelfRounds} self round(s), ${result.abandonedCrossRounds} cross round(s), ` +
        `${result.canceledRuns.length} node_run(s)`,
    )
  }
  return result
}
