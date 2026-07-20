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

import { and, eq, sql } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import {
  type NodeRunTransitionEvent,
  type NodeRunStatus,
  nextNodeRunStatus,
  isTerminalNodeRunStatus,
} from '@agent-workflow/shared'
import { nodeRuns } from '@/db/schema'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'

const lifecycleLog = createLogger('lifecycle')

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
    // RFC-145: the structured failure companions ride the same atomic write as
    // status + errorMessage (runner-exit stamps failureCode; the review
    // supersede path stamps supersededByReview/rolledBack).
    | 'failureCode'
    | 'supersededByReview'
    | 'rolledBack'
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

/**
 * Synchronous transaction companion for business operations that must move a
 * node_run together with other durable rows. It intentionally does not
 * broadcast: the caller emits frames only after the enclosing transaction
 * commits, preserving the lifecycle broadcast ordering rule above.
 */
export function setNodeRunStatusTx(args: {
  tx: DbTxSync
  nodeRunId: string
  to: NodeRunStatus
  allowedFrom: readonly NodeRunStatus[]
  extra?: NodeRunStatusUpdateExtra
  allowTerminal?: boolean
  reason?: string
}): { from: NodeRunStatus; to: NodeRunStatus } {
  const row = args.tx
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
    .get()
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
  // rfc053-allow-direct-status-write -- transactional companion of setNodeRunStatus
  const updated = args.tx
    .update(nodeRuns)
    .set({ status: args.to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
    .all()
  if (updated.length === 0) {
    throw new ConcurrentNodeRunTransition(
      args.nodeRunId,
      from,
      args.reason ?? `setNodeRunStatusTx to=${args.to}`,
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

import {
  TERMINAL_TASK_STATUSES,
  allowedFromForTaskEvent,
  targetForTaskEvent,
  type TaskStatus,
  type TaskTransitionEvent,
} from '@agent-workflow/shared'
import { tasks } from '@/db/schema'

// RFC-108 T2 (AR-19 / 01-LIFE-08): the terminal-task-status set now lives in
// @agent-workflow/shared (symmetric with node_run) so the frontend imports the
// same source instead of hand-enumerating it. Re-exported here for the many
// backend call sites that import it from this module.
export { TERMINAL_TASK_STATUSES }

export function isTerminalTaskStatus(s: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s)
}

/** Whitelisted companion columns (mirrors NodeRunStatusUpdateExtra; explicit
 *  null is allowed — resume clears the error quadruple, repair T3 clears
 *  finishedAt). `status` itself cannot be smuggled through here. RFC-109 adds
 *  `workflowSnapshot` + `workflowVersion` so syncTaskWorkflow can swap the
 *  frozen snapshot ATOMICALLY inside the same status CAS (no torn state where
 *  the snapshot changed but the ownership flip lost the race). RFC-167 adds
 *  `workgroupConfigJson` for the same reason: the dynamic-workflow confirm
 *  swaps the generated DAG into the snapshot AND flips dw.phase='executing'
 *  in ONE CAS, so a lost race can never leave phase and snapshot torn. */
export type TaskStatusUpdateExtra = Partial<
  Pick<
    typeof tasks.$inferInsert,
    | 'finishedAt'
    | 'errorSummary'
    | 'errorMessage'
    | 'failedNodeId'
    | 'workflowSnapshot'
    | 'workflowVersion'
    | 'workgroupConfigJson'
    // RFC-207 §3.8 — written ONLY by writeStatus below, never by callers.
    | 'runningMs'
    | 'runningSince'
  >
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
 * refused unless the caller holds the `allowTerminal` escape hatch (holders:
 * resumeTask, retryNode, repair CR-1, repair T3, and RFC-109 syncTaskWorkflow
 * — all via the `transitionTaskStatusByEvent` event path).
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
  /**
   * Optional synchronous companion writes that must commit or roll back with
   * the task ownership CAS. Used for decisions whose gate/config/message rows
   * would otherwise tear if resume loses or preflight fails.
   */
  onTransitionTx?: (tx: DbTxSync, transition: { from: TaskStatus; to: TaskStatus }) => void
  reason: string
}): Promise<{ from: TaskStatus; to: TaskStatus }> {
  const rows = await args.db
    .select({
      status: tasks.status,
      worktreePath: tasks.worktreePath,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
    })
    .from(tasks)
    .where(eq(tasks.id, args.taskId))
    .limit(1)
  if (rows.length === 0) {
    throw new NotFoundError('task-not-found', `task ${args.taskId} not found`)
  }
  const row = rows[0]!
  const from = row.status as TaskStatus
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
  // RFC-165 (R3-2): the workspace-revival gate, enforced at the SINGLE task
  // status writer so every revive path (resume / retry / sync-workflow /
  // lifecycle repair / boot auto-resume) shares it. A revival = a terminal
  // source resurrected to a live status; it needs a workspace, so:
  //   * workspace_pruned_at set  → the dir was reclaimed by GC → 410.
  //   * workspace_pruning_at set → GC holds the delete claim right now → 409.
  //   * dir missing on disk (legacy pre-tombstone GC, manual rm) → stamp the
  //     tombstone atomically and 410 (heals history forward — R3-2-r4).
  // The UPDATE below re-checks both stamps so a claim landing between this
  // read and the write loses cleanly (ConcurrentTaskTransition).
  const isRevival =
    args.allowTerminal === true && isTerminalTaskStatus(from) && !isTerminalTaskStatus(args.to)
  if (isRevival) {
    if (row.workspacePrunedAt !== null) {
      throw new DomainError(
        'workspace-pruned',
        `task ${args.taskId} workspace was reclaimed by GC; cannot ${args.reason}`,
        410,
      )
    }
    if (row.workspacePruningAt !== null) {
      throw new ConflictError(
        'workspace-pruning',
        `task ${args.taskId} workspace is being reclaimed by GC right now; retry after it finishes (${args.reason})`,
      )
    }
    if (row.worktreePath !== '' && !existsSync(row.worktreePath)) {
      await args.db
        .update(tasks)
        .set({ workspacePrunedAt: Date.now() })
        .where(
          and(
            eq(tasks.id, args.taskId),
            isNull(tasks.workspacePruningAt),
            isNull(tasks.workspacePrunedAt),
          ),
        )
      throw new DomainError(
        'workspace-pruned',
        `task ${args.taskId} workspace '${row.worktreePath}' no longer exists (reclaimed before tombstones existed); cannot ${args.reason}`,
        410,
      )
    }
  }
  const transition = { from, to: args.to }
  const writeStatus = (writer: Pick<DbClient, 'update'>) =>
    // rfc097-allow-direct-task-status-write -- single allowlisted writer
    writer
      .update(tasks)
      .set({
        status: args.to,
        // RFC-207 §3.8 — run-time accounting rides the single allowlisted status
        // writer so every one of the ~25 transition call sites is covered by
        // construction. Entering `running` opens a stretch; leaving it closes the
        // stretch into the accumulated total. Time spent parked, awaiting review or
        // awaiting a human answer therefore costs nothing against maxDurationMs.
        ...(args.to === 'running'
          ? { runningSince: Date.now() }
          : from === 'running'
            ? {
                runningMs: sql`${tasks.runningMs} + (${Date.now()} - COALESCE(${tasks.runningSince}, ${Date.now()}))`,
                runningSince: null,
              }
            : {}),
        ...(args.extra ?? {}),
      })
      .where(
        and(
          eq(tasks.id, args.taskId),
          eq(tasks.status, from),
          ...(isRevival ? [isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)] : []),
        ),
      )
      .returning({ id: tasks.id })
  if (args.onTransitionTx !== undefined) {
    dbTxSync(args.db, (tx) => {
      const updated = writeStatus(tx).all()
      if (updated.length === 0) {
        throw new ConcurrentTaskTransition(args.taskId, args.allowedFrom, args.reason)
      }
      args.onTransitionTx?.(tx, transition)
    })
  } else {
    const updated = await writeStatus(args.db)
    if (updated.length === 0) {
      throw new ConcurrentTaskTransition(args.taskId, args.allowedFrom, args.reason)
    }
  }
  // RFC-202 T2: unrevivable terminal statuses sweep the task's open human
  // gates (clarify rounds / review parks) so they leave the inbox for good.
  // Registered as a callback (cli/start.ts assembly) because lifecycle.ts is
  // the low-level primitive — importing clarify/review services here would
  // create a module cycle (binary-build hazard). Hook failures must never
  // undo or block the already-committed status write: warn and move on; the
  // read-path terminal filter (RFC-202 T6) and the write-path guards
  // (task-terminal 409s) keep the system consistent until the next sweep.
  if (args.to === 'done' || args.to === 'canceled') {
    try {
      terminalTaskHook?.(args.db, args.taskId, args.to)
    } catch (err) {
      lifecycleLog.warn(
        `terminal task hook failed for ${args.taskId} → ${args.to}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return transition
}

/**
 * RFC-202 T2 — terminal-task sweep hook. Wired once at daemon assembly
 * (cli/start.ts) to `sealOpenHumanGatesForTask`; kept as a registration to
 * avoid a lifecycle → clarify/review import cycle. Pass `null` to reset
 * (tests).
 */
export type TerminalTaskHook = (db: DbClient, taskId: string, to: TaskStatus) => void
let terminalTaskHook: TerminalTaskHook | null = null
export function registerTerminalTaskHook(fn: TerminalTaskHook | null): void {
  terminalTaskHook = fn
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

/**
 * RFC-108 T1 (AR-12 / 01-LIFE-01): event-path task-status write. Derives `to` +
 * `allowedFrom` from the shared `nextTaskStatus` oracle (`targetForTaskEvent` /
 * `allowedFromForTaskEvent`) instead of a hand-copied allowlist, so new
 * recovery writers (auto-resume, etc.) route through the single transition
 * table and can't drift (the half RFC-097 left undone). Thin wrapper over
 * setTaskStatus — keeps the RFC-097 CAS + `allowTerminal` escape hatch.
 *
 * NOTE: `resume` / `retry` events have terminal sources (failed/interrupted/
 * canceled/done) in their allowed-from set, so callers using those MUST pass
 * `allowTerminal: true` (mirrors resumeTask/retryNode). Existing call sites are
 * NOT migrated by this RFC — they keep their explicit `allowedFrom` and move
 * over incrementally (Codex audit cross-check: two-step, no big-bang churn).
 */
export async function transitionTaskStatusByEvent(args: {
  db: DbClient
  taskId: string
  event: TaskTransitionEvent
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  onTransitionTx?: (tx: DbTxSync, transition: { from: TaskStatus; to: TaskStatus }) => void
  reason: string
}): Promise<{ from: TaskStatus; to: TaskStatus }> {
  return setTaskStatus({
    db: args.db,
    taskId: args.taskId,
    to: targetForTaskEvent(args.event),
    allowedFrom: allowedFromForTaskEvent(args.event),
    ...(args.allowTerminal !== undefined ? { allowTerminal: args.allowTerminal } : {}),
    ...(args.extra !== undefined ? { extra: args.extra } : {}),
    ...(args.onTransitionTx !== undefined ? { onTransitionTx: args.onTransitionTx } : {}),
    reason: args.reason,
  })
}

// -----------------------------------------------------------------------------
// RFC-144 — node_runs.merge_state CAS (the third lifecycle: RFC-130 iso
// merge-back). Same triple as status: shared transition table
// (`nextMergeState`) + CAS helpers here + the rfc144 blind-write inventory
// guard keeping raw `update(nodeRuns).set({ mergeState: … })` out of every
// other module. merge_state's NULL is a REAL state (non-isolated /
// passthrough rows; every mint is born NULL), so the CAS predicate switches
// to IS NULL when from === null — `eq(col, null)` never matches in SQL.
// -----------------------------------------------------------------------------

import { inArray, isNull, lt, or } from 'drizzle-orm'
import {
  IllegalMergeStateTransition,
  type MergeState,
  type MergeStateOrNull,
  type MergeStateTransitionEvent,
  allowedFromForMergeEvent,
  nextMergeState,
} from '@agent-workflow/shared'
/** Companion columns that may ride along a merge_state transition — the iso
 *  snapshot quintet (begin-isolation pins the base, mark-pending-merge pins
 *  the result tree) plus wrapperProgressJson (reenter-isolation clears the
 *  prior generation's baseline ATOMICALLY with the merged→isolating flip, so
 *  a crash inside the re-entry window cannot leave a stale-baseline row that
 *  the next resume mistakes for a mid-generation one — RFC-144 D13).
 *  `mergeState` itself cannot be smuggled through. */
export type MergeStateUpdateExtra = Partial<
  Pick<
    typeof nodeRuns.$inferInsert,
    | 'isoWorktreePath'
    | 'isoBaseSnapshot'
    | 'isoBaseSnapshotReposJson'
    | 'isoNodeTree'
    | 'isoNodeTreeReposJson'
    | 'wrapperProgressJson'
  >
>

export class ConcurrentMergeStateTransition extends ConflictError {
  constructor(nodeRunId: string, expectedFrom: MergeStateOrNull, eventKind: string) {
    super(
      'concurrent-merge-state-transition',
      `node_run ${nodeRunId} merge_state changed concurrently (expected '${expectedFrom ?? 'NULL'}', event '${eventKind}')`,
    )
  }
}

/**
 * High-level merge_state transition by named event — the ONLY sanctioned
 * writer besides `abandonSupersededMergeStates` below. The event determines
 * both the legal `from` set and the resulting `to` (via `nextMergeState`).
 *
 * Throws:
 *   - NotFoundError('node-run-not-found') — row doesn't exist
 *   - IllegalMergeStateTransition — current merge_state doesn't allow this
 *     event (a logic bug surfacing; runTask's catch-all fails the task loud)
 *   - ConcurrentMergeStateTransition — CAS lost; another writer moved the row
 *     between our read and update
 */
export async function transitionMergeState(args: {
  db: DbClient
  nodeRunId: string
  event: MergeStateTransitionEvent
  extra?: MergeStateUpdateExtra
}): Promise<{ from: MergeStateOrNull; to: MergeState }> {
  const row = (
    await args.db
      .select({ mergeState: nodeRuns.mergeState })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = (row.mergeState ?? null) as MergeStateOrNull
  const to = nextMergeState(from, args.event)
  // rfc144-allow-direct-merge-state-write -- single allowlisted writer
  const updated = await args.db
    .update(nodeRuns)
    .set({ mergeState: to, ...(args.extra ?? {}) })
    .where(
      and(
        eq(nodeRuns.id, args.nodeRunId),
        from === null ? isNull(nodeRuns.mergeState) : eq(nodeRuns.mergeState, from),
      ),
    )
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    throw new ConcurrentMergeStateTransition(args.nodeRunId, from, args.event.kind)
  }
  return { from, to }
}

/**
 * Non-throwing variant for the merge-back ERROR paths (W10/W13/W16/W19 sit
 * inside catch blocks — a throw there would mask the original merge error).
 * Domain misses (illegal transition / concurrent write / row gone) fold to
 * false; everything else rethrows.
 */
export async function tryTransitionMergeState(args: {
  db: DbClient
  nodeRunId: string
  event: MergeStateTransitionEvent
  extra?: MergeStateUpdateExtra
}): Promise<boolean> {
  try {
    await transitionMergeState(args)
    return true
  } catch (err) {
    if (
      err instanceof ConflictError ||
      err instanceof NotFoundError ||
      err instanceof IllegalMergeStateTransition
    ) {
      return false
    }
    throw err
  }
}

/** The abandon event's from-set, DERIVED from the transition table so the
 *  set-based WHERE below can never drift from `nextMergeState` (add a state
 *  to the abandon row there and this picks it up automatically). */
const ABANDONABLE_MERGE_STATES = allowedFromForMergeEvent({
  kind: 'abandon',
  reason: 'derive-from-set',
}).filter((s): s is MergeState => s !== null)

/**
 * RFC-144 abandon invariant (abandoned ⇔ superseded): flip every prior
 * generation of `(taskId, nodeId, iteration)` still parked in an in-flight
 * merge_state — plus the CHILD rows of those prior generations (fanout
 * shard / aggregator / merge-resolve children are superseded with their
 * parent) — to 'abandoned', so the runTask-entry replays can never
 * materialize a superseded delta into canonical (the stale-replay bug).
 *
 * Set-based guarded write: the IN(from-set) predicate IS the transition
 * guard — only legal abandon sources can flip; merged / merge-failed /
 * abandoned rows are untouchable through this path. Idempotent.
 *
 * SYNCHRONOUS on purpose (drizzle `.all()` surface): the mint chokepoint
 * must run abandon + insert atomically inside ONE dbTxSync (design D12 —
 * a crash between two separate statements would leave the superseded row
 * replayable, resurrecting the bug this exists to fix).
 *
 * The abandon REASON is not persisted here: the superseding row's
 * `rerun_cause` column already records why the generation turned over.
 */
export function abandonSupersededMergeStates(args: {
  db: DbClient | DbTxSync
  taskId: string
  nodeId: string
  iteration: number
  /** ULID of the freshly-minted superseding row; only strictly-older rows flip. */
  supersededByRunId: string
  /** RFC-172b (Codex impl-gate P1): when the minting node fans out per shard (the workgroup
   *  `__wg_member__` host: ONE node, many concurrent member assignments keyed by node_runs.shard_key),
   *  retire ONLY the SAME shard's prior generations. Otherwise minting member B's rerun would abandon
   *  member A's STILL-RUNNING run (its `isolating`→`pending-merge` never completes → A's writes are
   *  lost). `undefined` (every non-member mint) = node-wide, byte-identical to today (golden-lock).
   *  Callers pass `null → undefined` so only a real member shard scopes. */
  shardKey?: string | null
}): number {
  // (a) prior top-level generations of the same (task, node, iteration[, shard]).
  const priorTopLevel = args.db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        eq(nodeRuns.nodeId, args.nodeId),
        eq(nodeRuns.iteration, args.iteration),
        isNull(nodeRuns.parentNodeRunId),
        lt(nodeRuns.id, args.supersededByRunId),
        ...(args.shardKey === undefined
          ? []
          : [
              args.shardKey === null
                ? isNull(nodeRuns.shardKey)
                : eq(nodeRuns.shardKey, args.shardKey),
            ]),
      ),
    )
    .all()
    .map((r) => r.id)
  if (priorTopLevel.length === 0) return 0
  // rfc144-allow-direct-merge-state-write -- set-based abandon (WHERE 即转移守卫)
  const abandoned = args.db
    .update(nodeRuns)
    .set({ mergeState: 'abandoned' })
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        inArray(nodeRuns.mergeState, ABANDONABLE_MERGE_STATES),
        or(inArray(nodeRuns.id, priorTopLevel), inArray(nodeRuns.parentNodeRunId, priorTopLevel)),
      ),
    )
    .returning({ id: nodeRuns.id })
    .all()
  return abandoned.length
}
