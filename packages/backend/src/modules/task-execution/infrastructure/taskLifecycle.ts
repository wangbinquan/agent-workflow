import { tablesOf } from '@/platform/persistence/sessionTables'
import { type TaskReadRow, taskReadColumns } from './taskRepositorySql'

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

import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { driveAsyncProgram } from '@/platform/persistence/transactionProgram'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import {
  allowedFromStatusesForEvent,
  isTaskWorkspaceUnbound,
  type NodeRunStatus,
  type NodeRunTransitionEvent,
  TERMINAL_TASK_STATUSES,
  allowedFromForTaskEvent,
  targetForTaskEvent,
  type TaskStatus,
  type TaskTransitionEvent,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import type { NodeRunLifecycleWrite as NodeRunStatusUpdateExtra } from '../application/ports/nodeRunWrites'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import {
  assertTaskExecutionContext,
  currentTaskExecutionContext,
} from '../application/taskExecutionContext'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import { lockNodeRunTaskRootInTx } from './nodeRunWriteProtocol'
import {
  transitionNodeRunStatusTx as transitionNodeRunStatusInTx,
  setNodeRunStatusTx as setNodeRunStatusInTransaction,
  transitionNodeRunStatusTx as transitionNodeRunStatusInTransaction,
} from './nodeRunLifecycleTransition'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import {
  appendTaskLifecycleTransitionCommittedEvent,
  type TaskCommittedEventIdentity,
} from './taskLifecycleCommittedEvents'
import {
  taskLifecycleWriteSequence,
  type TaskLifecycleWriteExtra,
  type TaskLifecycleWriteInput,
} from './taskLifecycleWriteSequence'
import { withOwnedTaskWrite } from './taskOwnershipPersistence'
import { resolveTerminalWorkspacePruneDecision } from './terminalWorkspacePrune'
export type { NodeRunLifecycleWrite as NodeRunStatusUpdateExtra } from '../application/ports/nodeRunWrites'

// RFC-359 W8 —— 转移判据 / 错误类型 / 字段白名单下沉到叶子
// `platform/persistence/nodeRunLifecycleCore.ts`，同步版与中立异步孪生都向下取用同一份。
// 这里继续 re-export，`@/services/lifecycle` 与既有调用方的 import 路径一格不动。
export {
  ConcurrentNodeRunTransition,
  assertNodeRunSourceTerminationAdmission,
} from '@/platform/persistence/nodeRunLifecycleCore'

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
  // RFC-359 W8：体内已全部走中立原语（中立预读 + `withTaskExecutionWrite` + `fenceTaskWrite`
  // + 中立异步 CAS），不再有 bun:sqlite 独有的同步面——两个引擎都跑得动，签名随之放宽
  // （与 W4-D28b 放宽 `transitionMergeState` 同形）。
  db: PersistenceDb
  nodeRunId: string
  event: NodeRunTransitionEvent
  extra?: NodeRunStatusUpdateExtra
  executionContext?: TaskExecutionContextRef
}): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const { nodeRuns } = tablesOf(args.db)
  const [row] = await args.db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
  if (!row) throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  const context = args.executionContext ?? currentTaskExecutionContext(row.taskId)
  return withTaskExecutionWrite(args.db, async (tx) => {
    await fenceTaskWrite(tx, { taskId: row.taskId, context })
    await lockNodeRunTaskRootInTx(tx, args.nodeRunId)
    return transitionNodeRunStatusInTransaction({ ...args, tx })
  })
}

/** Async companion; caller owns the transaction, owner fence and Task root lock. */
export const transitionNodeRunStatusTx = transitionNodeRunStatusInTransaction

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
  // RFC-359 W8：同 `transitionNodeRunStatus`——体内两条分支都已中立，签名放宽到两个引擎共用。
  db: PersistenceDb
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
  executionContext?: TaskExecutionContextRef
}): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const { nodeRuns } = tablesOf(args.db)
  const [row] = await args.db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
  if (!row) throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  const context = args.executionContext ?? currentTaskExecutionContext(row.taskId)
  return withTaskExecutionWrite(args.db, async (tx) => {
    await fenceTaskWrite(tx, { taskId: row.taskId, context })
    await lockNodeRunTaskRootInTx(tx, args.nodeRunId)
    return setNodeRunStatusInTransaction({ ...args, tx })
  })
}

/** Async companion; caller owns the transaction, owner fence and Task root lock. */
export const setNodeRunStatusTx = setNodeRunStatusInTransaction

// -----------------------------------------------------------------------------
// RFC-097 — tasks.status CAS (audit S-8 / S-14 / WP-4): the RFC-053 triple
// (transition table + CAS helper + direct-write ratchet) replicated to the
// tasks table. Every `tasks.status` write goes through setTaskStatus /
// trySetTaskStatus below; the s14 source-text guard keeps direct
// `update(tasks).set({ status: … })` out of every other module.
// -----------------------------------------------------------------------------

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
 *  the snapshot changed but the ownership flip lost the race). RFC-292 adds
 *  `refClosureJson` to that same CAS: a candidate root and the closure frozen
 *  for that exact root are one execution snapshot and may never tear. RFC-167 adds
 *  `workgroupConfigJson` for the same reason: the dynamic-workflow confirm
 *  swaps the generated DAG into the snapshot AND flips dw.phase='executing'
 *  in ONE CAS, so a lost race can never leave phase and snapshot torn. */
export type TaskStatusUpdateExtra = TaskLifecycleWriteExtra
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
export type WorkspacePruneCause = NonNullable<TaskReadRow['workspacePruneCause']>

/**
 * RFC-359 —— 同一个写序列的**异步解释**。
 *
 * `taskLifecycleWriteSequence` 本来就是 provider 中立的 transaction program，它的头注释写得很直白：
 * 「The caller owns the transaction and chooses synchronous or asynchronous interpretation.」
 * 所以这里不是第二台机器，只是换一个解释器（`driveAsyncProgram`）与一个异步的事件追加
 * （`appendTaskLifecycleTransitionCommittedEvent`，中立版，`humanGateTaskTransition.ts` 与
 * PostgreSQL 路由早就在用）。同步那份**保留**——RFC-333 的人工门参与者挂在别人的同步大事务上，
 * 它要的就是同步解释。
 */
async function writeTaskStatusAsync(
  input: TaskLifecycleWriteInput<PersistenceTx> & {
    readonly tx: PersistenceTx
    readonly allowedFrom: readonly TaskStatus[]
    readonly reason: string
  },
): Promise<Readonly<{ revision: number; eventRef: CommittedEventRef | null }>> {
  const result = await driveAsyncProgram(
    taskLifecycleWriteSequence(
      input.tx,
      input,
      async (tx, event) =>
        await appendTaskLifecycleTransitionCommittedEvent(tx, {
          ...event,
          sourceTerminationEffectRef: event.sourceTerminationEffectRef ?? null,
        }),
    ),
    async (step) => await step(),
  )
  if (result === null) {
    throw new ConcurrentTaskTransition(input.taskId, input.allowedFrom, input.reason)
  }
  return { revision: result.lifecycleEventRevision, eventRef: result.eventRef }
}

/**
 * RFC-359 —— `cancelOpenNodeRunsTx` 的中立异步孪生。判据一字不差：同一张
 * `allowedFromStatusesForEvent({ kind: 'mark-canceled' })` 的可取消状态集，逐行走共用的
 * 节点转移表（中立的 `transitionNodeRunStatusInTx`）。
 */
export async function cancelOpenNodeRuns(args: {
  readonly tx: PersistenceTx
  readonly taskId: string
  readonly finishedAt: number
  readonly errorMessage: string
}): Promise<Array<{ id: string; nodeId: string }>> {
  const cancelableStatuses = allowedFromStatusesForEvent({ kind: 'mark-canceled' })
  const { nodeRuns } = tablesOf(args.tx)
  const rows = await args.tx
    .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, args.taskId), inArray(nodeRuns.status, [...cancelableStatuses])))
  for (const row of rows) {
    await transitionNodeRunStatusInTx({
      tx: args.tx,
      nodeRunId: row.id,
      event: { kind: 'mark-canceled', reason: args.errorMessage },
      extra: {
        identity: {
          finishedAt: args.finishedAt,
          errorMessage: args.errorMessage,
        },
      },
    })
  }
  return rows
}

// RFC-359：联合的唯一定义在 `modules/task-execution/infrastructure/humanGateTaskTransition.ts`
// （human-gate 跃迁本身归那一层）；这里只把它转出去，`services/lifecycle.ts` 的 import 路径不动。
export type { HumanGateTaskTransition } from './humanGateTaskTransition'

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
  // RFC-359 AC-6：形参放宽到中立客户端。函数体本来就是中立的——它走
  // `databaseSessionFor(db).transaction(...)` + 中立异步 CAS，一条 bun:sqlite 同步游标都没有
  // （W8 把那条 `.get()` 预读改掉时就是为此）。放宽是向后兼容的：`DbClient` 是它的子类型。
  db: PersistenceDb
  taskId: string
  to: TaskStatus
  allowedFrom: readonly TaskStatus[]
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  /**
   * Optional synchronous companion writes that must commit or roll back with
   * the task lifecycle/admission CAS. Used for decisions whose gate/config/message rows
   * would otherwise tear if resume loses or preflight fails.
   */
  onTransitionTx?: (
    tx: PersistenceTx,
    transition: { from: TaskStatus; to: TaskStatus },
    collector: { addNodeChanges(changes: readonly TaskNodeChangeV1[]): void },
  ) => void | Promise<void>
  /**
   * RFC-328 exact durable worker authority.  Control/maintenance callers omit
   * this and enter through their own revision/proof gateways; a scheduler
   * worker must pass the context created by the claim→attach handoff.
   */
  executionContext?: TaskExecutionContextRef
  committedEventIdentity?: Partial<TaskCommittedEventIdentity>
  sourceTerminationEffectRef?: string | null
  /**
   * Delay compatibility projection until an enclosing process-local mutation
   * queue has released. The durable event is already committed when invoked.
   */
  deferCommittedEventPublication?: (eventRefs: readonly CommittedEventRef[]) => void
  /** RFC-207 — injectable clock for the run-time accounting (test determinism). */
  now?: number
  /**
   * RFC-359 —— **读→CAS 窗口**里的注入点。本函数先读一次状态定出 `from`，再在写事务里以
   * `WHERE status = from` 做 CAS；这个回调恰好落在两者之间，是「别的生命周期写者在窗口里
   * 把行挪走」这件事唯一能被确定性注入的位置。**生产从不传**，只有锁 CAS 失败语义的回归判据传。
   *
   * 为什么注入点必须做进来：统一事务原语不走 drizzle 的 `db.transaction`、SQLite 上事务句柄
   * 就是 db 对象本身、而且它会串行化写者——从外面包 db 代理的老办法在新原语下**一次都不触发**，
   * 用例照样绿却一个并发场景都没验（`docs/dev-gotchas.md` 有完整复盘）。
   */
  beforeCas?: () => void | Promise<void>
  reason: string
}): Promise<{ from: TaskStatus; to: TaskStatus }> {
  const { tasks } = tablesOf(args.db)
  const rows = await args.db
    .select({
      status: tasks.status,
      worktreePath: taskReadColumns(args.db).worktreePath,
      spaceKind: taskReadColumns(args.db).spaceKind,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePruneCause: tasks.workspacePruneCause,
      workspacePrunedAt: tasks.workspacePrunedAt,
      sourceTerminationFence: tasks.sourceTerminationFence,
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      errorSummary: tasks.errorSummary,
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
    if (!isTaskWorkspaceUnbound(row.worktreePath) && !existsSync(row.worktreePath)) {
      await withTaskExecutionWrite(args.db, async (tx) => {
        await fenceTaskWrite(tx, {
          taskId: args.taskId,
          ...(args.executionContext === undefined ? {} : { context: args.executionContext }),
        })
        const { tasks } = tablesOf(tx)
        await tx
          .update(tasks)
          .set({ workspacePrunedAt: Date.now() })
          .where(
            and(
              eq(tasks.id, args.taskId),
              isNull(tasks.workspacePruningAt),
              isNull(tasks.workspacePrunedAt),
            ),
          )
      })
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
  const workspacePruneDecision = await resolveTerminalWorkspacePruneDecision(
    {
      taskId: args.taskId,
      spaceKind: row.spaceKind,
      workspacePruningAt: row.workspacePruningAt,
      workspacePruneCause: row.workspacePruneCause,
      workspacePrunedAt: row.workspacePrunedAt,
    },
    args.to,
  )
  let committedEventRef: CommittedEventRef | null = null
  // RFC-359 —— 写事务从 bun:sqlite 专属的同步面（`dbTxSync` / `withOwnedTaskTx`）搬到中立的
  // 显式边界。写序列本身一个字没改：`taskLifecycleWriteSequence` 是同一个 program，
  // 这里换的只是解释器（见 `writeTaskStatusAsync` 的注释）。
  //
  // 代价是事务体里出现了事件循环让渡窗口，护栏见 `platform/persistence/databaseTransaction.ts`
  // 头注释三条。最要紧的一条是**事务体只 await 数据库操作**：本函数体内除写序列外只有
  // `onTransitionTx` 一个外部回调，它的四个生产实现（`services/task.ts`）也只做库写。
  // 新增回调时这条要继续守住。
  const commitTransition = async (tx: PersistenceTx): Promise<void> => {
    const committed = await writeTaskStatusAsync({
      tx,
      taskId: args.taskId,
      from,
      to: args.to,
      allowedFrom: args.allowedFrom,
      ...(args.extra === undefined ? {} : { extra: args.extra }),
      now,
      reason: args.reason,
      isRevival,
      workspacePruneDecision,
      previousErrorSummary: row.errorSummary,
      committedEventIdentity: args.committedEventIdentity,
      sourceTerminationEffectRef: args.sourceTerminationEffectRef,
      ...(args.onTransitionTx === undefined ? {} : { onTransitionTx: args.onTransitionTx }),
    })
    committedEventRef = committed.eventRef
  }
  await args.beforeCas?.()
  const executionContext = args.executionContext ?? currentTaskExecutionContext(args.taskId)
  if (executionContext !== undefined) {
    assertTaskExecutionContext(executionContext, args.taskId)
    await withOwnedTaskWrite({
      db: args.db,
      token: executionContext.token,
      now,
      run: async (tx) => await commitTransition(tx),
    })
  } else {
    await databaseSessionFor(args.db).transaction(commitTransition)
  }
  const committedEventRefs = committedEventRef === null ? [] : [committedEventRef]
  if (args.deferCommittedEventPublication === undefined) {
    await publishCommittedEventsAfterCommit(committedEventRefs)
  } else {
    args.deferCommittedEventPublication(committedEventRefs)
  }
  return transition
}

/**
 * Non-throwing variant for callers whose CAS-loss handling is "respect the
 * winner and move on" (scheduler terminal writes, orphan/shutdown reapers,
 * cancel fallback). Returns whether this writer won. Status-gate misses
 * (from outside allowedFrom / terminal without escape hatch) also return
 * false — the caller semantics are identical to a lost race.
 */
export async function trySetTaskStatus(args: {
  // RFC-359 AC-6：同 `setTaskStatus`，它整个就是把参数转交过去，函数体零方言。
  db: PersistenceDb
  taskId: string
  to: TaskStatus
  allowedFrom: readonly TaskStatus[]
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  onTransitionTx?: (
    tx: PersistenceTx,
    transition: { from: TaskStatus; to: TaskStatus },
    collector: { addNodeChanges(changes: readonly TaskNodeChangeV1[]): void },
  ) => void | Promise<void>
  executionContext?: TaskExecutionContextRef
  committedEventIdentity?: Partial<TaskCommittedEventIdentity>
  sourceTerminationEffectRef?: string | null
  /**
   * 与 `setTaskStatus` 同一个注入点（本函数原样转交 `args`，运行时一直是通的，
   * 只是类型上没声明）。RFC-359 AC-6 补声明：CAS 竞态判据要在 SELECT 与 UPDATE 之间
   * 插入竞争写者，而这是唯一**被 await 的**、两个引擎都成立的时机——
   * 此前测试靠代理 `db.run`/`db.transaction` 模拟，那依赖 bun:sqlite 的同步落库，
   * 在 PostgreSQL 上不成立（见 `rfc097-task-status-cas.test.ts` 头注释）。
   */
  beforeCas?: () => void | Promise<void>
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
  db: PersistenceDb
  taskId: string
  event: TaskTransitionEvent
  allowTerminal?: boolean
  extra?: TaskStatusUpdateExtra
  onTransitionTx?: (
    tx: PersistenceTx,
    transition: { from: TaskStatus; to: TaskStatus },
    collector: { addNodeChanges(changes: readonly TaskNodeChangeV1[]): void },
  ) => void | Promise<void>
  executionContext?: TaskExecutionContextRef
  committedEventIdentity?: Partial<TaskCommittedEventIdentity>
  sourceTerminationEffectRef?: string | null
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
    ...(args.executionContext !== undefined ? { executionContext: args.executionContext } : {}),
    ...(args.committedEventIdentity !== undefined
      ? { committedEventIdentity: args.committedEventIdentity }
      : {}),
    ...(args.sourceTerminationEffectRef !== undefined
      ? { sourceTerminationEffectRef: args.sourceTerminationEffectRef }
      : {}),
    reason: args.reason,
  })
}
