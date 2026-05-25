// RFC-061 PR-A T3 — event-applier (events → projections).
//
// Pure function from a `RawEvent` to a batch of projection-table mutations.
// Called transactionally by `writeEvents` (one event at a time, batch
// order) and by `projectionRebuilder` (every event from scratch).
//
// **Sync by design.** drizzle's bun-sqlite transaction wrapper is itself
// synchronous (see node_modules/drizzle-orm/bun-sqlite/session.js): it
// calls the callback once, then COMMITs as soon as the callback returns.
// An async callback returns a Promise immediately, the wrapper sees no
// throw, COMMITs, then microtasks run AFTER the transaction is already
// committed. To keep INSERT-projection atomicity, both this function and
// the writeEvents transaction body run synchronously over drizzle's
// `.run()` / `.all()` / `.get()` API.
//
// In PR-A the applier ONLY touches the new RFC-061 projection tables —
// logical_runs / attempts / node_outputs / suspensions. The existing
// `tasks` and `lifecycle_alerts` tables stay under their legacy services
// (services/task.ts, services/lifecycleInvariants.ts) until PR-B switches
// the hot path.
//
// design.md §2 + §6 spell out the per-EventKind projection rules; the
// switch below is the authoritative implementation. The `default:` branch
// with `_exhaustive: never` makes TypeScript fail to compile if any
// EventKind slips through unhandled.

import { and, eq } from 'drizzle-orm'

import { type DbClient } from '../db/client'
import { attempts, logicalRuns, nodeOutputs, suspensions } from '../db/schema'
import {
  decodeEvent,
  type Event,
  type EventKind,
  type EventPayload,
  type RawEvent,
} from '@agent-workflow/shared'

/** Transaction or top-level db client; both satisfy the same surface. */
export type DbOrTx = Parameters<DbClient['transaction']>[0] extends (tx: infer T) => unknown
  ? DbClient | T
  : DbClient

/**
 * Mutate the projection tables for one event. Synchronous — runs entirely
 * inside the caller's transaction (or auto-commits if no tx is open). The
 * caller is responsible for transactional batching across multiple events.
 *
 * Idempotency: NOT idempotent in general — re-applying a `logical-run-
 * created` to a populated projection would violate UNIQUE on
 * (taskId, nodeId, loopIter, shardKey, iter). Callers must reset
 * projections before re-applying from scratch (see projectionRebuilder).
 */
export function applyEvent(db: DbOrTx, rawEvent: RawEvent): void {
  const event = decodeEvent(rawEvent)
  switch (event.kind) {
    /* ============================================================
     *  task-level — events recorded; tasks.status stays under
     *  legacy services/task.ts management in PR-A.
     * ============================================================ */
    case 'task-created':
    case 'task-started':
    case 'task-paused':
    case 'task-canceled':
    case 'task-completed':
    case 'task-failed':
    case 'task-resumed-after-daemon-restart':
      return

    /* ============================================================
     *  logical-run-level
     * ============================================================ */
    case 'logical-run-created': {
      const scope = requireScope(event)
      db.insert(logicalRuns)
        .values({
          id: event.id,
          taskId: event.taskId,
          nodeId: scope.nodeId,
          loopIter: scope.loopIter,
          shardKey: scope.shardKey,
          iter: scope.iter,
          status: 'pending',
          createdAt: event.ts,
          updatedAt: event.ts,
          lastEventId: event.id,
        })
        .run()
      return
    }

    case 'logical-run-iter-bumped': {
      const scope = requireScope(event)
      db.insert(logicalRuns)
        .values({
          id: event.id,
          taskId: event.taskId,
          nodeId: scope.nodeId,
          loopIter: scope.loopIter,
          shardKey: scope.shardKey,
          iter: scope.iter,
          status: 'pending',
          createdAt: event.ts,
          updatedAt: event.ts,
          lastEventId: event.id,
        })
        .run()
      return
    }

    case 'logical-run-completed': {
      const scope = requireScope(event)
      loadLogicalRun(db, event.taskId, scope) // throws if missing
      db.update(logicalRuns)
        .set({ status: 'done', updatedAt: event.ts, lastEventId: event.id })
        .where(matchLogicalRunByScope(event.taskId, scope))
        .run()
      return
    }

    case 'logical-run-canceled': {
      const scope = requireScope(event)
      loadLogicalRun(db, event.taskId, scope)
      db.update(logicalRuns)
        .set({ status: 'canceled', updatedAt: event.ts, lastEventId: event.id })
        .where(matchLogicalRunByScope(event.taskId, scope))
        .run()
      return
    }

    /* ============================================================
     *  attempt-level
     * ============================================================ */
    case 'attempt-started': {
      const scope = requireScope(event)
      requireAttemptId(event)
      const lr = loadLogicalRun(db, event.taskId, scope)
      const seq = nextAttemptSeq(db, lr.id)
      const p = event.payload as EventPayload<'attempt-started'>
      db.insert(attempts)
        .values({
          id: event.attemptId!,
          logicalRunId: lr.id,
          attemptSeq: seq,
          pid: p.pid ?? null,
          opencodeSessionId: p.opencodeSessionId ?? null,
          startedAt: event.ts,
          preSnapshot: p.preSnapshot ?? null,
        })
        .run()
      db.update(logicalRuns)
        .set({ status: 'running', updatedAt: event.ts, lastEventId: event.id })
        .where(eq(logicalRuns.id, lr.id))
        .run()
      return
    }

    case 'attempt-finished-success': {
      requireAttemptId(event)
      db.update(attempts)
        .set({ outcome: 'success', finishedAt: event.ts })
        .where(eq(attempts.id, event.attemptId!))
        .run()
      return
    }

    case 'attempt-finished-envelope-fail': {
      requireAttemptId(event)
      const p = event.payload as EventPayload<'attempt-finished-envelope-fail'>
      db.update(attempts)
        .set({
          outcome: 'envelope-fail',
          finishedAt: event.ts,
          errorMessage: p.reason,
        })
        .where(eq(attempts.id, event.attemptId!))
        .run()
      return
    }

    case 'attempt-finished-crash': {
      requireAttemptId(event)
      const p = event.payload as EventPayload<'attempt-finished-crash'>
      db.update(attempts)
        .set({
          outcome: 'crash',
          finishedAt: event.ts,
          exitCode: p.exitCode ?? null,
          errorMessage: p.errorMessage ?? null,
        })
        .where(eq(attempts.id, event.attemptId!))
        .run()
      return
    }

    case 'attempt-finished-timeout': {
      requireAttemptId(event)
      db.update(attempts)
        .set({ outcome: 'timeout', finishedAt: event.ts })
        .where(eq(attempts.id, event.attemptId!))
        .run()
      return
    }

    case 'attempt-canceled': {
      requireAttemptId(event)
      const p = event.payload as EventPayload<'attempt-canceled'>
      db.update(attempts)
        .set({
          outcome: 'canceled',
          finishedAt: event.ts,
          errorMessage: p.reason ?? null,
        })
        .where(eq(attempts.id, event.attemptId!))
        .run()
      return
    }

    case 'attempt-output-captured': {
      const scope = requireScope(event)
      const p = event.payload as EventPayload<'attempt-output-captured'>
      db.insert(nodeOutputs)
        .values({
          taskId: event.taskId,
          nodeId: scope.nodeId,
          loopIter: scope.loopIter,
          shardKey: scope.shardKey,
          iter: scope.iter,
          portName: p.portName,
          content: p.content,
          capturedAt: event.ts,
          sourceEventId: event.id,
        })
        .run()
      return
    }

    case 'attempt-subagent-tool-use':
    case 'attempt-subagent-output':
    case 'attempt-token-usage':
      return

    /* ============================================================
     *  suspension-level
     * ============================================================ */
    case 'suspension-created': {
      const scope = requireScope(event)
      const p = event.payload as EventPayload<'suspension-created'>
      const lr = loadLogicalRun(db, event.taskId, scope)
      db.insert(suspensions)
        .values({
          id: p.suspensionId,
          logicalRunId: lr.id,
          signalKind: p.signalKind,
          awaitsActor: p.awaitsActor,
          payload: JSON.stringify(p.body ?? null),
          createdAt: event.ts,
        })
        .run()
      db.update(logicalRuns)
        .set({ status: 'suspended', updatedAt: event.ts, lastEventId: event.id })
        .where(eq(logicalRuns.id, lr.id))
        .run()
      return
    }

    case 'suspension-resolved': {
      const p = event.payload as EventPayload<'suspension-resolved'>
      db.update(suspensions)
        .set({ resolvedAt: event.ts, resolvedByEventId: event.id })
        .where(eq(suspensions.id, p.suspensionId))
        .run()
      return
    }

    case 'suspension-terminated': {
      const p = event.payload as EventPayload<'suspension-terminated'>
      db.update(suspensions)
        .set({ resolvedAt: event.ts, resolvedByEventId: event.id })
        .where(eq(suspensions.id, p.suspensionId))
        .run()
      return
    }

    /* ============================================================
     *  invariant-level — events recorded; lifecycle_alerts stays
     *  under legacy services/lifecycleInvariants.ts management.
     * ============================================================ */
    case 'invariant-alert-detected':
    case 'invariant-alert-resolved':
      return

    default: {
      const _exhaustive: never = event
      throw new Error(`unhandled EventKind in applyEvent: ${String(_exhaustive)}`)
    }
  }
}

/* ============================================================
 *  Helpers (sync)
 * ============================================================ */

interface ResolvedScope {
  nodeId: string
  loopIter: number
  shardKey: string
  iter: number
}

function requireScope(event: Event): ResolvedScope {
  if (
    event.nodeId === null ||
    event.loopIter === null ||
    event.shardKey === null ||
    event.iter === null
  ) {
    throw new Error(
      `event ${event.kind} ${event.id} requires full scope but got ${JSON.stringify({
        nodeId: event.nodeId,
        loopIter: event.loopIter,
        shardKey: event.shardKey,
        iter: event.iter,
      })}`,
    )
  }
  return {
    nodeId: event.nodeId,
    loopIter: event.loopIter,
    shardKey: event.shardKey,
    iter: event.iter,
  }
}

function requireAttemptId(event: Event): asserts event is Event & { attemptId: string } {
  if (event.attemptId === null) {
    throw new Error(`event ${event.kind} ${event.id} requires attemptId but got null`)
  }
}

function matchLogicalRunByScope(taskId: string, scope: ResolvedScope) {
  return and(
    eq(logicalRuns.taskId, taskId),
    eq(logicalRuns.nodeId, scope.nodeId),
    eq(logicalRuns.loopIter, scope.loopIter),
    eq(logicalRuns.shardKey, scope.shardKey),
    eq(logicalRuns.iter, scope.iter),
  )
}

function loadLogicalRun(db: DbOrTx, taskId: string, scope: ResolvedScope): { id: string } {
  const rows = db
    .select({ id: logicalRuns.id })
    .from(logicalRuns)
    .where(matchLogicalRunByScope(taskId, scope))
    .limit(1)
    .all()
  const row = rows[0]
  if (!row) {
    throw new Error(`no logical_run row at scope ${JSON.stringify(scope)} for task ${taskId}`)
  }
  return row
}

function nextAttemptSeq(db: DbOrTx, logicalRunId: string): number {
  const rows = db
    .select({ seq: attempts.attemptSeq })
    .from(attempts)
    .where(eq(attempts.logicalRunId, logicalRunId))
    .all()
  let max = -1
  for (const r of rows) {
    if (r.seq > max) max = r.seq
  }
  return max + 1
}

/* ============================================================
 *  Re-exports for tests
 * ============================================================ */
export type { EventKind, RawEvent }
