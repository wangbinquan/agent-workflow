// RFC-053 PR-B P-1 — backend-side CAS wrapper for node_runs.status writes.
//
// Every site that needs to change `node_runs.status` should go through one of:
//
//   - transitionNodeRunStatus({ db, nodeRunId, event, extra? })
//     High-level API: looks up current status, computes next via
//     `nextNodeRunStatus(cur, event)`, then CAS-updates. Throws
//     IllegalNodeRunTransition if the transition isn't allowed, or
//     ConcurrentNodeRunTransition if another writer raced us.
//
//   - setNodeRunStatus({ db, nodeRunId, to, allowedFrom, extra? })
//     Lower-level API for sites whose semantics don't fit the event ADT
//     (wrapper finalize collapses 4 different reasons into a single
//     "wrapper terminated"; runner exit chooses among done|failed at
//     runtime depending on envelope parsing). Caller supplies the
//     explicit `allowedFrom` allowlist. Still CAS-strict.
//
// ESLint rule `no-direct-node-run-status-write` enforces that direct
// `db.update(nodeRuns).set({ status: ... })` only appears inside this file.
//
// Broadcast ordering rule (RFC-098 B3, audit S-28): write the DB FIRST, then
// broadcast. A `node.status` WS ping must always FOLLOW the CAS that produced
// the status it reports — listeners re-read the row synchronously on receipt
// (useTaskSync invalidation, the s07-s28 test harness), so an eager broadcast
// ahead of the write surfaces a status the DB doesn't hold yet and the chip
// snaps back on refresh. Callers of these helpers place their
// broadcastNodeStatus AFTER the helper returns; never the other way around.

import { and, eq } from 'drizzle-orm'
import {
  type NodeRunTransitionEvent,
  type NodeRunStatus,
  nextNodeRunStatus,
  isTerminalNodeRunStatus,
} from '@agent-workflow/shared'
import { nodeRuns } from '@/db/schema'
import type { DbClient } from '@/db/client'
import { ConflictError, NotFoundError } from '@/util/errors'

/**
 * Extra fields that may be written alongside a status transition (mirrors
 * common drizzle .set({}) shapes — runner pid/finishedAt/error, scheduler
 * preSnapshot, review reviewIteration/clarifyIteration, etc.). Whitelisted
 * here so callers can't smuggle `status` through this path.
 */
export type NodeRunStatusUpdateExtra = Partial<
  Pick<
    typeof nodeRuns.$inferInsert,
    | 'finishedAt'
    | 'startedAt'
    | 'errorMessage'
    | 'exitCode'
    | 'pid'
    | 'reviewIteration'
    | 'preSnapshot'
    | 'opencodeSessionId'
    | 'tokInput'
    | 'tokOutput'
    | 'tokCacheCreate'
    | 'tokCacheRead'
    | 'tokTotal'
  >
>

/**
 * Raised when CAS UPDATE affected 0 rows — the row's status is no longer
 * the value we read a moment ago (someone else wrote it concurrently), or
 * the row was deleted. Mapped to HTTP 409 by `util/errors`.
 */
export class ConcurrentNodeRunTransition extends ConflictError {
  constructor(nodeRunId: string, expectedFrom: NodeRunStatus, eventKind: string) {
    super(
      'concurrent-node-run-transition',
      `node_run ${nodeRunId} status changed concurrently (expected '${expectedFrom}', event '${eventKind}')`,
    )
  }
}

/**
 * High-level transition by named event. The event determines both the
 * legal `from` set and the resulting `to` (via `nextNodeRunStatus`).
 *
 * Throws:
 *   - NotFoundError('node-run-not-found') — row doesn't exist
 *   - IllegalNodeRunTransition — current status doesn't allow this event
 *     (e.g., trying to approve a row that is `done`)
 *   - ConcurrentNodeRunTransition — CAS lost the race; another writer
 *     moved the row out of `expectedFrom` between our read and update
 */
export async function transitionNodeRunStatus(args: {
  db: DbClient
  nodeRunId: string
  event: NodeRunTransitionEvent
  extra?: NodeRunStatusUpdateExtra
}): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const row = (
    await args.db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = row.status as NodeRunStatus
  const to = nextNodeRunStatus(from, args.event)
  // CAS: WHERE id = ? AND status = expectedFrom. Drizzle's bun-sqlite
  // returns the affected row(s) via .returning(); affectedRows.length === 0
  // means another writer changed status between our SELECT and UPDATE.
  // rfc053-allow-direct-status-write -- single allowlisted writer
  const updated = await args.db
    .update(nodeRuns)
    .set({ status: to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    throw new ConcurrentNodeRunTransition(args.nodeRunId, from, args.event.kind)
  }
  return { from, to }
}

/**
 * Lower-level CAS update for sites whose business decision about `to`
 * doesn't fit the event ADT. Caller passes:
 *   - `to`: the resulting status
 *   - `allowedFrom`: explicit allowlist of legal current statuses
 *
 * The helper:
 *   - Refuses if current is in TERMINAL_NODE_RUN_STATUSES (callers that
 *     genuinely need to rewrite terminal rows pass `allowTerminal: true`,
 *     intended for fixup scripts only)
 *   - Refuses if current is not in `allowedFrom` (throws IllegalTransition)
 *   - Otherwise CAS-updates; throws ConcurrentNodeRunTransition if the
 *     race lost
 *
 * Prefer `transitionNodeRunStatus()` when the transition has a clear name.
 */
export async function setNodeRunStatus(args: {
  db: DbClient
  nodeRunId: string
  to: NodeRunStatus
  allowedFrom: readonly NodeRunStatus[]
  extra?: NodeRunStatusUpdateExtra
  /** Default false. Set true ONLY for fixup scripts — never in normal flows. */
  allowTerminal?: boolean
  /** Diagnostic label for errors — appears in the IllegalTransition message. */
  reason?: string
}): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const row = (
    await args.db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = row.status as NodeRunStatus
  if (isTerminalNodeRunStatus(from) && args.allowTerminal !== true) {
    throw new ConflictError(
      'illegal-node-run-transition',
      `node_run ${args.nodeRunId} is terminal ('${from}'); refuse to overwrite${args.reason ? ` (${args.reason})` : ''}`,
    )
  }
  if (!args.allowedFrom.includes(from)) {
    throw new ConflictError(
      'illegal-node-run-transition',
      `node_run ${args.nodeRunId} status='${from}' not in allowedFrom=[${args.allowedFrom.join(',')}]${args.reason ? ` (${args.reason})` : ''}`,
    )
  }
  // rfc053-allow-direct-status-write -- single allowlisted writer
  const updated = await args.db
    .update(nodeRuns)
    .set({ status: args.to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    throw new ConcurrentNodeRunTransition(
      args.nodeRunId,
      from,
      args.reason ?? `setNodeRunStatus to=${args.to}`,
    )
  }
  return { from, to: args.to }
}

// -----------------------------------------------------------------------------
// RFC-097 — tasks.status CAS (audit S-8 / S-14 / WP-4): the RFC-053 triple
// (transition table + CAS helper + direct-write ratchet) replicated to the
// tasks table. Every `tasks.status` write goes through setTaskStatus /
// trySetTaskStatus below; the s14 source-text guard keeps direct
// `update(tasks).set({ status: … })` out of every other module.
// -----------------------------------------------------------------------------

import type { TaskStatus } from '@agent-workflow/shared'
import { tasks } from '@/db/schema'

export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'canceled', 'interrupted'] as const

export function isTerminalTaskStatus(s: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s)
}

/** Whitelisted companion columns (mirrors NodeRunStatusUpdateExtra; explicit
 *  null is allowed — resume clears the error quadruple, repair T3 clears
 *  finishedAt). `status` itself cannot be smuggled through here. */
export type TaskStatusUpdateExtra = Partial<
  Pick<typeof tasks.$inferInsert, 'finishedAt' | 'errorSummary' | 'errorMessage' | 'failedNodeId'>
>

export class ConcurrentTaskTransition extends ConflictError {
  constructor(taskId: string, expectedFrom: readonly string[], reason: string) {
    super(
      'concurrent-task-transition',
      `task ${taskId} status changed concurrently (expected one of [${expectedFrom.join(',')}]) — ${reason}`,
    )
  }
}

/**
 * CAS-strict task status write. `allowedFrom` is the explicit legal-source
 * set for this transition (RFC-097 design §1 matrix); terminal sources are
 * refused unless the caller holds the `allowTerminal` escape hatch (exactly
 * four holders: resumeTask, retryNode, repair CR-1, repair T3).
 *
 * Throws ConflictError('illegal-task-transition') when the current status is
 * outside `allowedFrom`, ConcurrentTaskTransition when the CAS lost a race.
 */
export async function setTaskStatus(args: {
  db: DbClient
  taskId: string
  to: TaskStatus
  allowedFrom: readonly TaskStatus[]
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  reason: string
}): Promise<{ from: TaskStatus; to: TaskStatus }> {
  const rows = await args.db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, args.taskId))
    .limit(1)
  if (rows.length === 0) {
    throw new NotFoundError('task-not-found', `task ${args.taskId} not found`)
  }
  const from = rows[0]!.status as TaskStatus
  if (isTerminalTaskStatus(from) && args.allowTerminal !== true) {
    throw new ConflictError(
      'illegal-task-transition',
      `task ${args.taskId} is terminal ('${from}'); refuse to overwrite (${args.reason})`,
    )
  }
  if (!args.allowedFrom.includes(from)) {
    throw new ConflictError(
      'illegal-task-transition',
      `task ${args.taskId} status='${from}' not in allowedFrom=[${args.allowedFrom.join(',')}] (${args.reason})`,
    )
  }
  // rfc097-allow-direct-task-status-write -- single allowlisted writer
  const updated = await args.db
    .update(tasks)
    .set({ status: args.to, ...(args.extra ?? {}) })
    .where(and(eq(tasks.id, args.taskId), eq(tasks.status, from)))
    .returning({ id: tasks.id })
  if (updated.length === 0) {
    throw new ConcurrentTaskTransition(args.taskId, args.allowedFrom, args.reason)
  }
  return { from, to: args.to }
}

/**
 * Non-throwing variant for callers whose CAS-loss handling is "respect the
 * winner and move on" (scheduler terminal writes, orphan/shutdown reapers,
 * cancel fallback). Returns whether this writer won. Status-gate misses
 * (from outside allowedFrom / terminal without escape hatch) also return
 * false — the caller semantics are identical to a lost race.
 */
export async function trySetTaskStatus(args: {
  db: DbClient
  taskId: string
  to: TaskStatus
  allowedFrom: readonly TaskStatus[]
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  reason: string
}): Promise<boolean> {
  try {
    await setTaskStatus(args)
    return true
  } catch (err) {
    if (err instanceof ConflictError || err instanceof NotFoundError) return false
    throw err
  }
}
