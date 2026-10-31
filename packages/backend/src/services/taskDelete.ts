// RFC-222/RFC-305 (B 线) — `tasks:delete` hard delete of a terminal task.
//
// Route gate is the `tasks:delete` point declared on the route.
// This service owns the rest of the contract:
//
//   Front gates (§6.2) — all 409:
//     · status ∉ terminal            → task-not-terminal
//     · task is active in-memory     → task-active   (cancel-timeout / running)
//     · fusion-internal task         → task-internal (its worktree backs the
//                                       Fusion approval flow; Fusion owns its
//                                       lifecycle)
//   Held under the per-task write lock so an in-flight writer can't race the
//   delete. The terminal re-check + row deletion run in ONE transaction, so a
//   concurrent resume either loses the terminal re-read (→ 409) or finds the
//   row gone (its CAS fails cleanly — deletion is the row's death, not a
//   transition). RFC-359 W7: that transaction is the provider-neutral
//   `databaseSessionFor(db).transaction(...)`, not the bun:sqlite-only
//   `dbTxSync`, and the terminal-maintenance claim it fences is the same
//   neutral store both provider composition roots assemble.
//
//   Cascade: the 12 FK-cascade tables clear automatically (foreign_keys=ON).
//   task_feedback is deleted explicitly (no FK, task-scoped). Pending task
//   lifecycle publication rows are also purged explicitly: their FK prevents a
//   hard delete and a deleted task is no longer a valid Event Center subject.
//   memory_distill_jobs / recovery_events / lifecycle_repair_audit are RETAINED
//   (memory / DR / append-only audit — they outlive the task, dangling taskId
//   is intended).
//
//   RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀的前置）：本文件的库句柄从 bun:sqlite 专有的
//   `LegacySqliteTaskDatabase` 放宽到中立句柄。原来卡住它的只有五处 `.get()`——那是
//   bun:sqlite 独有的同步终结符，中立面上没有对应物；改写成 `await … .limit(1)` 再取 `[0]`
//   之后整份实现就是普通 drizzle 查询 + 中立事务原语了。这是把 `delete` 两个引擎合成一份的
//   必要前提（PostgreSQL 那侧目前是另一份 184 行的内联实现）。
//
//   Disk cleanup is best-effort AFTER the tx: worktree + snapshot refs + scratch.
//   Anything that fails (or a crash between tx-commit and cleanup) is swept by
//   the worktree/scratch orphan GC — a tasks row no longer anchors those dirs,
//   so they become reapable orphans (services/gc.ts runWorktreeOrphanGc).
//
// NOTE (design §6.5 P1-9 follow-up): the task.deleted frame is broadcast on the
// tasks-list channel. Connections that have the task cached-visible (owner /
// members / tasks:read:all) receive it live; cold-cache connections refresh on
// their next poll / reconnect. The workflow-style audience-context fast-path
// for cold connections is a documented follow-up.

import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { projectStoredTaskRepositorySurface } from '@/platform/persistence/taskRepositorySurface'
import { createTaskDeletionQueries } from '@/modules/task-execution/public/queries'
import { createTaskDeletionParticipantInTx } from '@/modules/task-execution/public/participants'
import { createTaskDeletionCollaborationParticipantInTx } from '@/modules/collaboration/public/participants'
import type { TaskDeletionEffects } from '@/modules/task-execution/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import type { ActiveTaskExecutionParticipant } from '@/modules/task-execution/public/participants'
import { ConflictError, NotFoundError } from '@/util/errors'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  assertTerminalMaintenanceClaimTx,
  createTerminalMaintenanceStore,
  transitionTerminalMaintenanceClaimTx,
} from '@/services/taskExecutionParticipants'
import {
  cleanupDeletedTaskResources,
  recoverInterruptedTaskDeletes,
  selectedTaskDeletionEffects,
  type DeleteCleanupPlanV2,
  type DeleteRecoveryResult,
  type DeleteWorktreeTarget as WorktreeTarget,
} from '@/modules/task-execution/infrastructure/taskDeleteRecovery'

export interface DeleteTaskResult {
  taskId: string
  cleanup: 'done' | 'pending'
}

/**
 * Hard-delete a terminal task. Throws NotFoundError (404) if absent, or
 * ConflictError (409) for a non-terminal / active / fusion-internal task.
 */
/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：`delete` 两个引擎共用这一份。
 *
 * `activity` 是**注入的**进程内活跃度参与者，不再是模块级全局 `isTaskActive`。
 * 那个端口的文档原话就是「runtime 绝不 import legacy 注册表」；更要紧的是，
 * 只有注入版本才能在两个引擎上被测——W7 的 A19 至今没有 `task-active` 那一格，
 * 正是因为 SQLite 侧驱不动模块全局。**不给默认值**：全可选的依赖面会静默降级
 *（`docs/dev-gotchas.md` 有这条），少接一格就等于这道门在那条路上不存在。
 */
export async function deleteTask(
  db: PersistenceDb,
  taskId: string,
  options: Readonly<{ activity: ActiveTaskExecutionParticipant; effects?: TaskDeletionEffects }>,
): Promise<DeleteTaskResult> {
  const effects = selectedTaskDeletionEffects(options.effects)
  const queries = createTaskDeletionQueries(db)
  const row = await queries.read(taskId)
  if (row === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)

  // Front gates (pre-lock cheap checks).
  if (!isTerminalTaskStatus(row.status as TaskStatus)) {
    throw new ConflictError(
      'task-not-terminal',
      `task '${taskId}' is ${row.status}; cancel it first`,
      {
        status: row.status,
      },
    )
  }
  // RFC-359 AC-1（第 5 刀）：**先报永久性的主因，再报暂时性的次因**。
  // 合并前 SQLite 是 `active → internal`、PostgreSQL 是 `internal → active`，于是一个
  // 「既是框架内部、又有活进程」的任务两侧回不同的 code。取 PG 那一档：`task-internal`
  // 是「这个任务永远不能直接删」，`task-active` 是「先取消再来」——把用户引向一条死路
  // 比引向一次重试更糟。与 `diff` 的 409/410 次序同一条判据。
  if (row.spaceKind === 'internal') {
    throw new ConflictError(
      'task-internal',
      `task '${taskId}' is a framework-internal (fusion) task and cannot be deleted directly`,
    )
  }
  if (options.activity.isActive(taskId)) {
    throw new ConflictError(
      'task-active',
      `task '${taskId}' still has an active process; cancel it first`,
    )
  }
  // RFC-243 §4.4 — two-way parent/child gates.
  // Deleting a PARENT while any descendant is non-terminal would cascade-drop
  // live children's rows out from under their schedulers.
  {
    const active = await queries.nonTerminalDescendant(taskId)
    if (active !== null) {
      throw new ConflictError(
        'task-has-active-children',
        `task '${taskId}' has a non-terminal child execution ('${active.id}' is ${active.status}); cancel the tree first`,
      )
    }
  }
  // Deleting a CHILD before its parent consumed the result would dangle the
  // call row's child_task_id (outputs/merge sources gone). The parent being
  // terminal implies its call rows are settled (boot reap flips crashed rows
  // to interrupted, which is terminal).
  if (row.parentTaskId !== null) {
    const parent = await queries.status(row.parentTaskId)
    if (parent !== undefined && !isTerminalTaskStatus(parent.status as TaskStatus)) {
      throw new ConflictError(
        'task-parent-active',
        `task '${taskId}' is a child execution of non-terminal task '${row.parentTaskId}'; the parent must settle first`,
      )
    }
  }

  // Freeze the complete member set before collecting its cleanup resources.
  // The claim revalidates this same snapshot before it becomes authoritative.
  const terminalMaintenance = createTerminalMaintenanceStore(db)
  const maintenanceMembers = await terminalMaintenance.snapshotTree(taskId)
  for (const member of maintenanceMembers) {
    if (options.activity.isActive(member.taskId)) {
      throw new ConflictError(
        'task-active',
        `task '${member.taskId}' still has an active process; cancel it first`,
      )
    }
  }
  const maintenanceTaskIds = maintenanceMembers.map((member) => member.taskId)

  // Capture every owned worktree BEFORE deletion (taskRepos cascades away with
  // the rows). Inherited children borrow their parent's isolation and therefore
  // never contribute a cleanup target of their own.
  const { tasks: memberTaskRows, repositories: repoRows } =
    await queries.workspaces(maintenanceTaskIds)
  const worktrees: WorktreeTarget[] = [
    ...new Map(
      memberTaskRows
        .filter((taskRow) => taskRow.spaceKind !== 'inherited')
        .flatMap((taskRow) => {
          const owned = repoRows.filter((repo) => repo.taskId === taskRow.id)
          return owned.length > 0
            ? owned.map((repo) => ({ repoPath: repo.repoPath, worktreePath: repo.worktreePath }))
            : projectStoredTaskRepositorySurface(taskRow).repos.map(
                ({ repoPath, worktreePath }) => ({ repoPath, worktreePath }),
              )
        })
        .map((target) => [`${target.repoPath}\u0000${target.worktreePath}`, target] as const),
    ).values(),
  ]
    // RFC-287 G7：准备失败 / 准备窗口内的任务 `task_repos` 为空、两个路径都是空串，
    // 于是这里会用两个空串去调 git，拿到 `fatal: '' is not a working tree`，API 回给
    // 调用方一个**假的** `cleanup: "pending"`——任务与 node_runs 其实已经删干净了，
    // 只是从来就没有工作树要清（四轮门 Codex 契约面实测）。空路径直接不进清理面。
    .filter((w) => !isTaskWorkspaceUnbound(w.worktreePath) && w.repoPath !== '')

  // RFC-328: claim the complete terminal tree before the first destructive
  // database or filesystem action.  This is durable, so a crash leaves a
  // resumable cleanup manifest instead of reopening continuation admission.
  const cleanupPlan: DeleteCleanupPlanV2 = {
    v: 2,
    taskId,
    parentTaskId: row.parentTaskId,
    worktrees,
    directories: maintenanceTaskIds.flatMap((id) =>
      effects.content.directories(id, memberTaskRows.find((row) => row.id === id)?.worktreePath),
    ),
  }
  let maintenanceClaim = await terminalMaintenance.claim({
    rootTaskId: taskId,
    operation: 'delete',
    members: maintenanceMembers,
    cleanupPlanJson: JSON.stringify(cleanupPlan),
  })
  // The immutable member/ledger/cleanup manifest is now frozen.  Advancing to
  // io-complete makes the following DB deletion restartable without claiming
  // that best-effort filesystem cleanup has already succeeded.
  maintenanceClaim = await terminalMaintenance.transition({
    claim: maintenanceClaim,
    to: 'io-complete',
  })

  // Serialize against in-flight writers, then re-check terminality and delete in
  // one transaction (closes the resume/retry TOCTOU — §6.2).
  const release = await getTaskWriteSem(taskId).acquire()
  let deletedAudiences: Array<{ taskId: string; visibleUserIds: ReadonlySet<string> }> = []
  // The claim this transaction fences is read from a `const`, never from the
  // mutable `maintenanceClaim`: the neutral primitive may replay the whole body
  // (SQLite retries a writer-contention BUSY, PostgreSQL a serialization
  // failure), and a body that had already advanced the revision would fence
  // against a claim that no longer exists on the second attempt.
  const claimBeforeDelete = maintenanceClaim
  try {
    maintenanceClaim = await databaseSessionFor(db).transaction(async (tx) => {
      await assertTerminalMaintenanceClaimTx(tx, {
        claim: claimBeforeDelete,
        expectedState: 'io-complete',
      })
      const participant = createTaskDeletionParticipantInTx(tx)
      const collaboration = createTaskDeletionCollaborationParticipantInTx(tx)
      const cascadeRows = await participant.cascade(taskId)
      const fresh = await participant.status(taskId)
      if (fresh === undefined) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
      if (!isTerminalTaskStatus(fresh.status as TaskStatus)) {
        throw new ConflictError(
          'task-not-terminal',
          `task '${taskId}' is ${fresh.status}; cancel it first`,
          {
            status: fresh.status,
          },
        )
      }
      // RFC-244: freeze the complete FK-cascade audience inside the deletion
      // transaction. Once the root delete commits neither rows nor memberships
      // remain available to the tasks-list frame gate.
      const cascadeIds = cascadeRows.map((item) => item.id)
      const claimedIds = maintenanceMembers.map((member) => member.taskId).sort()
      if (JSON.stringify([...cascadeIds].sort()) !== JSON.stringify(claimedIds)) {
        throw new ConflictError(
          'task-terminal-maintenance-conflict',
          `task tree '${taskId}' changed after terminal maintenance claim`,
        )
      }
      const memberRows = await collaboration.members(cascadeIds)
      deletedAudiences = cascadeRows.map((item) => {
        const visibleUserIds = new Set<string>()
        if (item.ownerUserId !== null) visibleUserIds.add(item.ownerUserId)
        for (const member of memberRows) {
          if (member.taskId === item.id) visibleUserIds.add(member.userId)
        }
        return { taskId: item.id, visibleUserIds }
      })
      // Explicit task-scoped deletes; committed lifecycle facts intentionally
      // survive task deletion as Event Center audit records.
      await collaboration.deleteFeedback(cascadeIds)
      await participant.deleteRoot(taskId)

      await participant.recomputeAncestors(row.parentTaskId)
      return await transitionTerminalMaintenanceClaimTx(tx, {
        claim: claimBeforeDelete,
        to: 'db-finalized',
        now: Date.now(),
      })
    })
  } finally {
    release()
  }

  // Best-effort disk cleanup (GC orphan-scan is the backstop). The exact plan
  // survives task-row deletion and is reused by boot recovery.
  const cleanup = await cleanupDeletedTaskResources(cleanupPlan, effects)
  for (const audience of deletedAudiences) {
    tasksListBroadcaster.broadcast(
      TASKS_LIST_CHANNEL,
      { type: 'task.deleted', taskId: audience.taskId },
      {
        kind: 'task.deleted-audience',
        taskId: audience.taskId,
        visibleUserIds: audience.visibleUserIds,
      },
    )
  }
  maintenanceClaim = await terminalMaintenance.transition({
    claim: maintenanceClaim,
    to: cleanup === 'done' ? 'completed' : 'cleanup-pending',
    releaseMembers: cleanup === 'done',
  })
  return { taskId, cleanup }
}

// RFC-359 T7c：删除认领的崩溃恢复是 provider 中立的一份实现（task-execution infrastructure），
// 这里只保留 cli/start.ts 与既有测试用的 import 路径。
export { recoverInterruptedTaskDeletes, type DeleteRecoveryResult }
