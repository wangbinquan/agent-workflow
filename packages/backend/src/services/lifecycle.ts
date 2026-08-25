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
// RFC-317 T49（findings LC-07）—— 这里原本有一句：「某条 ESLint 规则强制
// `db.update(nodeRuns).set({ status: ... })` 只能出现在本文件内」，并点了那条规则的名字。
// **那条规则在全仓不存在**：`eslint.config.js` 只有 js/tseslint recommended、react 规则
// 与三个 `no-restricted-imports` 块，没有自定义插件、没有 rules 目录、没有本地规则包；
// 全仓搜那个名字，唯一命中就是那句注释自己。
//
// 这是最坏的一类过期断言：**审内核是否密封的人第一眼读到的就是它**，会据此认定存在
// 一条 lint 级、不可绕过的守卫，从而不再去查真正的防线。真正的防线是
// `packages/backend/tests/lifecycle-grep-guard.test.ts` 的源码扫描——它挡得住直写，
// 但**可被文件内的注释标记 opt out**（findings LC-02），强度与 lint 规则不是一回事。
//
// 直写 `db.update(nodeRuns).set({ status: ... })` 的约束由那个守卫承担；本文件是唯一
// 被授权这么做的地方。⚠️ 别再把那个规则名写回任何注释里：
// `tests/architecture/rfc317-allow-terminal-ledger.test.ts` 断言它在全仓零命中，
// 写回去会红——那是刻意的，避免同一句谎话被复述。
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
import { nodeRuns, taskLifecycleEventOutbox, tasks } from '@/db/schema'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'

const lifecycleLog = createLogger('lifecycle')

const SOURCE_TERMINATION_BLOCKED_NODE_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
])

/**
 * RFC-303 admission under a source-termination fence. RFC-326 exports it so the
 * review decision's pre-check (before any worktree rollback) and the transactional
 * helpers below apply ONE predicate instead of two copies that could drift.
 */
export function assertNodeRunSourceTerminationAdmission(
  taskId: string,
  fence: 'closed' | 'merged' | null,
  to: NodeRunStatus,
): void {
  if (fence === null || !SOURCE_TERMINATION_BLOCKED_NODE_STATUSES.has(to)) return
  throw new ConflictError(
    fence === 'closed' ? 'task-source-terminal-closed' : 'task-source-terminal-merged',
    `task ${taskId} is fenced by an MR/PR ${fence} event; cannot move a node run to ${to}`,
  )
}

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
  // RFC-326: a pure wrapper around the transactional companion — the ONLY
  // status write for this event kind now lives in transitionNodeRunStatusTx, so
  // the kernel's direct-write count (lifecycle-grep-guard) stays at three.
  return dbTxSync(args.db, (tx) => transitionNodeRunStatusTx({ tx, ...args }))
}

/**
 * Synchronous transaction companion of `transitionNodeRunStatus` (RFC-326): the
 * same event table, the same fence admission, the same CAS — inside a caller's
 * `dbTxSync` so a review decision can move the review row together with the
 * rows it archives, mints and retires. Does not broadcast; the caller emits after
 * commit (see the ordering rule at the top of this file).
 */
export function transitionNodeRunStatusTx(args: {
  tx: DbTxSync
  nodeRunId: string
  event: NodeRunTransitionEvent
  extra?: NodeRunStatusUpdateExtra
}): { from: NodeRunStatus; to: NodeRunStatus } {
  const row = args.tx
    .select({
      status: nodeRuns.status,
      taskId: nodeRuns.taskId,
      sourceTerminationFence: tasks.sourceTerminationFence,
    })
    .from(nodeRuns)
    .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
    .get()
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = row.status as NodeRunStatus
  const to = nextNodeRunStatus(from, args.event)
  assertNodeRunSourceTerminationAdmission(row.taskId, row.sourceTerminationFence, to)
  // CAS: WHERE id = ? AND status = expectedFrom. Drizzle's bun-sqlite
  // returns the affected row(s) via .returning(); affectedRows.length === 0
  // means another writer changed status between our SELECT and UPDATE.
  // rfc053-allow-direct-status-write -- single allowlisted writer (RFC-326: Tx form)
  const updated = args.tx
    .update(nodeRuns)
    .set({ status: to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
    .all()
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
  /**
   * 允许把**终态**行改写掉。默认 false。
   *
   * ⚠️ RFC-317 T49（findings LC-03）—— 这里原本写着「Set true ONLY for fixup scripts
   * — never in normal flows」。实测**不成立**：全仓 21 个生产站点传它，其中包含正常
   * 用户流程（review supersede 把 `done` 的 node_run 改写成 `canceled`、评审兄弟级联
   * 把 `done` 改回 `pending`）。共享表在这件事上是斩钉截铁的——`nextNodeRunStatus`
   * 对任何终态 `cur` 直接抛。
   *
   * 现状逐文件记在 `tests/architecture/rfc317-allow-terminal-ledger.test.ts`（只减不增，
   * 每条写清它改写的是哪种终态→X）。**新增站点前先去读那份账本**：文档说「五个持有者」
   * 而实际二十一个的时候，审第 22 个站点的人是没有基线的。
   */
  allowTerminal?: boolean
  /** Diagnostic label for errors — appears in the IllegalTransition message. */
  reason?: string
}): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const row = (
    await args.db
      .select({
        status: nodeRuns.status,
        taskId: nodeRuns.taskId,
        sourceTerminationFence: tasks.sourceTerminationFence,
      })
      .from(nodeRuns)
      .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
      .where(eq(nodeRuns.id, args.nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = row.status as NodeRunStatus
  assertNodeRunSourceTerminationAdmission(row.taskId, row.sourceTerminationFence, args.to)
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
    .select({
      status: nodeRuns.status,
      taskId: nodeRuns.taskId,
      sourceTerminationFence: tasks.sourceTerminationFence,
    })
    .from(nodeRuns)
    .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
    .get()
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const from = row.status as NodeRunStatus
  assertNodeRunSourceTerminationAdmission(row.taskId, row.sourceTerminationFence, args.to)
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
// RFC-243 §1.4: multicast terminal notification (executionWatch is a leaf
// module — db schema + shared only — so this import cannot form a cycle).
import { notifyTaskTerminal } from '@/services/execution/executionWatch'
// RFC-243 §3.2: child-task budget bookkeeping (leaf module, no-op until a call
// node initializes the daemon singleton).
import { notifyChildBudgetTaskStatus } from '@/services/execution/childBudget'
import { taskLifecycleObservation } from '@/modules/task-execution/public/events'

// RFC-108 T2 (AR-19 / 01-LIFE-08): the terminal-task-status set now lives in
// @agent-workflow/shared (symmetric with node_run) so the frontend imports the
// same source instead of hand-enumerating it. Re-exported here for the many
// backend call sites that import it from this module.
export { TERMINAL_TASK_STATUSES }

export function isTerminalTaskStatus(s: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s)
}

/** Write the public lifecycle fact in the same transaction as its owner row. */
export function enqueueTaskLifecycleEventTx(
  tx: DbTxSync,
  input: {
    readonly taskId: string
    readonly revision: number
    readonly previousStatus: TaskStatus | null
    readonly status: TaskStatus
    readonly occurredAt: number
  },
): void {
  tx.insert(taskLifecycleEventOutbox)
    .values({
      id: `task-lifecycle:${input.taskId}:${input.revision}`,
      taskId: input.taskId,
      taskRevision: input.revision,
      observationJson: JSON.stringify(taskLifecycleObservation(input)),
      state: 'pending',
      attemptCount: 0,
      nextAttemptAt: input.occurredAt,
      createdAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .run()
}

/** Whitelisted companion columns (mirrors NodeRunStatusUpdateExtra; explicit
 *  null is allowed — resume clears the error quadruple, repair T3 clears
 *  finishedAt). `status` itself cannot be smuggled through here. RFC-109 adds
 *  `workflowSnapshot` + `workflowVersion` so syncTaskWorkflow can swap the
 *  frozen snapshot ATOMICALLY inside the same status CAS (no torn state where
 *  the snapshot changed but the ownership flip lost the race). RFC-292 adds
 *  `refClosureJson` to that same CAS: a candidate root and the closure frozen
 *  for that exact root are one execution snapshot and may never tear. RFC-167 adds
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
    | 'refClosureJson'
    | 'workgroupConfigJson'
    | 'sourceTerminationFence'
    | 'sourceTerminationEffectRev'
  >
>
// RFC-207 §3.8 — `runningMs` / `runningSince` are DELIBERATELY excluded from the
// caller-writable extra: they are computed by writeStatus below, and `extra`
// spreads AFTER that computation, so allowing them here would let any caller
// silently clobber the run-time accounting (and every existing test would stay
// green). Making them unrepresentable at the type level is the s14-style guard.
// See design/test-guard-audit-2026-07-21 gap B2-lifecycle-3.

export class ConcurrentTaskTransition extends ConflictError {
  constructor(taskId: string, expectedFrom: readonly string[], reason: string) {
    super(
      'concurrent-task-transition',
      `task ${taskId} status changed concurrently (expected one of [${expectedFrom.join(',')}]) — ${reason}`,
    )
  }
}

/**
 * 工作区回收原因的取值域，**从 schema 派生**而不是手抄。
 *
 * 手抄一份联合类型等于把同一个词汇表写两遍：schema 加一个取值时，这里不会红，
 * 而是安静地把新原因判成不合法。派生则让「取值域」只有一个事实源。
 */
export type WorkspacePruneCause = NonNullable<(typeof tasks.$inferSelect)['workspacePruneCause']>

/**
 * RFC-317 LC-04 —— 回收判定连**原因**一起由注入方给出。
 *
 * 原本 port 返回裸 `boolean`，于是「要不要回收」被外置了、而「这次回收叫什么名字」
 * 仍留在 kernel 里硬编码（`workspacePruneCause: 'webhook-terminal' as const`）。
 * 那是**半次反转**：策略搬出去了，词汇表没搬——第二个来源要表达自己的原因，唯一的
 * 办法就是回来改这个通用写点。闭合联合把「不回收就没有原因」也变成编译期事实。
 */
export type TerminalWorkspacePruneDecision =
  | { readonly prune: false }
  | { readonly prune: true; readonly cause: WorkspacePruneCause }

/** RFC-300: daemon-composed policy deciding whether this exact terminal CAS
 * must also durably claim the task's owned workspace. Lifecycle receives only
 * neutral ownership/tombstone facts plus the task id; any origin-specific
 * attribution column is read by the policy itself, so this generic writer names
 * zero integrations. It never imports config or integration services. */
export type TerminalWorkspacePrunePolicy = (
  row: {
    taskId: string
    spaceKind: (typeof tasks.$inferSelect)['spaceKind']
    workspacePruningAt: number | null
    workspacePruneCause: (typeof tasks.$inferSelect)['workspacePruneCause']
    workspacePrunedAt: number | null
  },
  to: TaskStatus,
) => TerminalWorkspacePruneDecision

/** RFC-300: post-commit wake-up for an already-durable claim. It is a separate
 * multicast concern from RFC-202's human-gate sweep; failures never undo the
 * terminal transition and boot/ticker reconciliation remains the backstop. */
export type TerminalWorkspacePruneEffect = (
  db: DbClient,
  taskId: string,
  to: 'done' | 'canceled',
) => void

let terminalWorkspacePrunePolicy: TerminalWorkspacePrunePolicy | null = null
let terminalWorkspacePruneEffect: TerminalWorkspacePruneEffect | null = null

export function registerTerminalWorkspacePrunePolicy(
  provider: TerminalWorkspacePrunePolicy | null,
): void {
  terminalWorkspacePrunePolicy = provider
}

export function registerTerminalWorkspacePruneEffect(
  effect: TerminalWorkspacePruneEffect | null,
): void {
  terminalWorkspacePruneEffect = effect
}

/**
 * CAS-strict task status write. `allowedFrom` is the explicit legal-source
 * set for this transition (RFC-097 design §1 matrix); terminal sources are
 * refused unless the caller holds the `allowTerminal` escape hatch.
 *
 * ⚠️ RFC-317 T49（findings LC-03）—— 这里原本点名了**五个持有者**（resumeTask /
 * retryNode / repair CR-1 / repair T3 / RFC-109 syncTaskWorkflow，「all via the
 * `transitionTaskStatusByEvent` event path」）。实际是 21 个生产站点，且并非都走事件路径。
 * 真实分布逐文件记在 `tests/architecture/rfc317-allow-terminal-ledger.test.ts`（只减不增）。
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
  /** RFC-207 — injectable clock for the run-time accounting (test determinism). */
  now?: number
  reason: string
}): Promise<{ from: TaskStatus; to: TaskStatus }> {
  const rows = await args.db
    .select({
      status: tasks.status,
      worktreePath: tasks.worktreePath,
      spaceKind: tasks.spaceKind,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePruneCause: tasks.workspacePruneCause,
      workspacePrunedAt: tasks.workspacePrunedAt,
      sourceTerminationFence: tasks.sourceTerminationFence,
      lifecycleEventRevision: tasks.lifecycleEventRevision,
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
    if (row.sourceTerminationFence !== null) {
      throw new ConflictError(
        row.sourceTerminationFence === 'closed'
          ? 'task-source-terminal-closed'
          : 'task-source-terminal-merged',
        `task ${args.taskId} is fenced by an MR/PR ${row.sourceTerminationFence} event; cannot ${args.reason}`,
      )
    }
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
  // RFC-207 — one clock read for the whole accounting so `runningSince` and the
  // `runningMs` delta are computed against the same instant (and are injectable
  // for deterministic tests).
  const now = args.now ?? Date.now()
  let workspacePruneDecision: TerminalWorkspacePruneDecision = { prune: false }
  if (terminalWorkspacePrunePolicy !== null && (args.to === 'done' || args.to === 'canceled')) {
    try {
      workspacePruneDecision = terminalWorkspacePrunePolicy(
        {
          taskId: args.taskId,
          spaceKind: row.spaceKind,
          workspacePruningAt: row.workspacePruningAt,
          workspacePruneCause: row.workspacePruneCause,
          workspacePrunedAt: row.workspacePrunedAt,
        },
        args.to,
      )
    } catch (err) {
      // Config is validated on normal daemon writes, but an out-of-band corrupt
      // file must not turn a successfully executed task into a lifecycle error.
      lifecycleLog.warn(
        `terminal workspace prune policy failed for ${args.taskId} → ${args.to}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
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
          ? { runningSince: now }
          : from === 'running'
            ? {
                runningMs: sql`${tasks.runningMs} + (${now} - COALESCE(${tasks.runningSince}, ${now}))`,
                runningSince: null,
              }
            : {}),
        ...(args.extra ?? {}),
        ...(workspacePruneDecision.prune
          ? { workspacePruningAt: now, workspacePruneCause: workspacePruneDecision.cause }
          : {}),
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, args.taskId),
          eq(tasks.status, from),
          ...(isRevival ? [isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)] : []),
          ...(workspacePruneDecision.prune
            ? [
                isNull(tasks.workspacePruningAt),
                isNull(tasks.workspacePruneCause),
                isNull(tasks.workspacePrunedAt),
              ]
            : []),
        ),
      )
      .returning({ id: tasks.id, lifecycleEventRevision: tasks.lifecycleEventRevision })
  dbTxSync(args.db, (tx) => {
    const updated = writeStatus(tx).all()
    if (updated.length === 0) {
      throw new ConcurrentTaskTransition(args.taskId, args.allowedFrom, args.reason)
    }
    enqueueTaskLifecycleEventTx(tx, {
      taskId: args.taskId,
      revision: updated[0]!.lifecycleEventRevision,
      previousStatus: from,
      status: args.to,
      occurredAt: now,
    })
    args.onTransitionTx?.(tx, transition)
  })
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
    if (workspacePruneDecision.prune) {
      try {
        terminalWorkspacePruneEffect?.(args.db, args.taskId, args.to)
      } catch (err) {
        lifecycleLog.warn(
          `terminal workspace prune effect failed for ${args.taskId} → ${args.to}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }
  // RFC-243 §1.4 — executionWatch multicast, for ALL FOUR terminal statuses
  // (the single-slot hook above deliberately stays done|canceled-only).
  // Post-commit and best-effort: a resolver failure never undoes or blocks
  // the already-committed status write; watchers own a poll fallback.
  if (isTerminalTaskStatus(args.to)) {
    try {
      notifyTaskTerminal(args.taskId, args.to)
    } catch (err) {
      lifecycleLog.warn(
        `terminal watch notify failed for ${args.taskId} → ${args.to}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  // RFC-243 §3.2 — child-task budget bookkeeping (EVERY status, not only
  // terminal: awaiting_* frees a unit, resume re-counts). No-op until the
  // budget singleton exists; never blocks the committed write.
  try {
    notifyChildBudgetTaskStatus(args.db, args.taskId, args.to)
  } catch (err) {
    lifecycleLog.warn(
      `child-budget notify failed for ${args.taskId} → ${args.to}: ${err instanceof Error ? err.message : String(err)}`,
    )
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
    // RFC-210: per-node submodule topology, written alongside the base snapshot.
    | 'isoSubmodulesJson'
    | 'isoSubmodulesReposJson'
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
