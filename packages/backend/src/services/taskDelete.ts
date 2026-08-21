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
//   delete. The terminal re-check + row deletion run in ONE dbTxSync tx, so a
//   concurrent resume either loses the terminal re-read (→ 409) or finds the
//   row gone (its CAS fails cleanly — deletion is the row's death, not a
//   transition).
//
//   Cascade: the 12 FK-cascade tables clear automatically (foreign_keys=ON).
//   task_feedback is deleted explicitly (no FK, task-scoped). Pending task
//   lifecycle publication rows are also purged explicitly: their FK prevents a
//   hard delete and a deleted task is no longer a valid Event Center subject.
//   memory_distill_jobs / recovery_events / lifecycle_repair_audit are RETAINED
//   (memory / DR / append-only audit — they outlive the task, dangling taskId
//   is intended).
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

import { eq, inArray, sql } from 'drizzle-orm'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  taskCollaborators,
  taskFeedback,
  taskLifecycleEventOutbox,
  taskRepos,
  tasks,
} from '@/db/schema'
import { isTaskActive } from '@/services/task'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { ConflictError, NotFoundError } from '@/util/errors'
import { deleteSnapshotRefs, removeWorktree } from '@/util/git'
import { Paths } from '@/util/paths'
import { createLogger } from '@/util/log'

const log = createLogger('task-delete')

/** A worktree the deleted task owned — captured BEFORE the row (and its
 *  cascade) vanish, so the post-tx cleanup still knows what to reap. */
interface WorktreeTarget {
  repoPath: string
  worktreePath: string
}

export interface DeleteTaskResult {
  taskId: string
  cleanup: 'done' | 'pending'
}

/**
 * Hard-delete a terminal task. Throws NotFoundError (404) if absent, or
 * ConflictError (409) for a non-terminal / active / fusion-internal task.
 */
export async function deleteTask(db: DbClient, taskId: string): Promise<DeleteTaskResult> {
  const row = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      spaceKind: tasks.spaceKind,
      worktreePath: tasks.worktreePath,
      repoPath: tasks.repoPath,
      parentTaskId: tasks.parentTaskId,
      parentNodeRunId: tasks.parentNodeRunId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
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
  if (isTaskActive(taskId)) {
    throw new ConflictError(
      'task-active',
      `task '${taskId}' still has an active process; cancel it first`,
    )
  }
  if (row.spaceKind === 'internal') {
    throw new ConflictError(
      'task-internal',
      `task '${taskId}' is a framework-internal (fusion) task and cannot be deleted directly`,
    )
  }
  // RFC-243 §4.4 — two-way parent/child gates.
  // Deleting a PARENT while any descendant is non-terminal would cascade-drop
  // live children's rows out from under their schedulers.
  {
    const active = await findNonTerminalDescendant(db, taskId)
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
    const parent = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, row.parentTaskId))
      .get()
    if (parent !== undefined && !isTerminalTaskStatus(parent.status as TaskStatus)) {
      throw new ConflictError(
        'task-parent-active',
        `task '${taskId}' is a child execution of non-terminal task '${row.parentTaskId}'; the parent must settle first`,
      )
    }
  }

  // Capture every worktree BEFORE deletion (taskRepos cascades away with the row).
  const repoRows = await db
    .select({ repoPath: taskRepos.repoPath, worktreePath: taskRepos.worktreePath })
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
  const worktrees: WorktreeTarget[] = (
    repoRows.length
      ? repoRows.map((r) => ({ repoPath: r.repoPath, worktreePath: r.worktreePath }))
      : [{ repoPath: row.repoPath, worktreePath: row.worktreePath }]
  )
    // RFC-287 G7：准备失败 / 准备窗口内的任务 `task_repos` 为空、两个路径都是空串，
    // 于是这里会用两个空串去调 git，拿到 `fatal: '' is not a working tree`，API 回给
    // 调用方一个**假的** `cleanup: "pending"`——任务与 node_runs 其实已经删干净了，
    // 只是从来就没有工作树要清（四轮门 Codex 契约面实测）。空路径直接不进清理面。
    .filter((w) => w.worktreePath !== '' && w.repoPath !== '')

  // Serialize against in-flight writers, then re-check terminality and delete in
  // one transaction (closes the resume/retry TOCTOU — §6.2).
  const release = await getTaskWriteSem(taskId).acquire()
  let deletedAudiences: Array<{ taskId: string; visibleUserIds: ReadonlySet<string> }> = []
  try {
    dbTxSync(db, (tx) => {
      const fresh = tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
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
      const cascadeRows = tx.all(sql`
        WITH RECURSIVE cascade(id) AS (
          SELECT id FROM tasks WHERE id = ${taskId}
          UNION
          SELECT child.id
          FROM tasks child
          JOIN cascade parent ON child.parent_task_id = parent.id
        )
        SELECT t.id, t.owner_user_id
        FROM tasks t
        JOIN cascade c ON c.id = t.id
      `) as Array<{ id: string; owner_user_id: string | null }>
      const cascadeIds = cascadeRows.map((item) => item.id)
      const memberRows =
        cascadeIds.length === 0
          ? []
          : tx
              .select({ taskId: taskCollaborators.taskId, userId: taskCollaborators.userId })
              .from(taskCollaborators)
              .where(inArray(taskCollaborators.taskId, cascadeIds))
              .all()
      deletedAudiences = cascadeRows.map((item) => {
        const visibleUserIds = new Set<string>()
        if (item.owner_user_id !== null) visibleUserIds.add(item.owner_user_id)
        for (const member of memberRows) {
          if (member.taskId === item.id) visibleUserIds.add(member.userId)
        }
        return { taskId: item.id, visibleUserIds }
      })
      // Explicit task-scoped deletes; the remaining FK tables cascade with the
      // task row. Lifecycle publication rows deliberately use a restrictive FK
      // so no generic task deletion can silently orphan an Event Center fact.
      tx.delete(taskFeedback).where(eq(taskFeedback.taskId, taskId)).run()
      if (cascadeIds.length > 0) {
        tx.delete(taskLifecycleEventOutbox)
          .where(inArray(taskLifecycleEventOutbox.taskId, cascadeIds))
          .run()
      }
      tx.delete(tasks).where(eq(tasks.id, taskId)).run()

      // RFC-311 实现门 P1-6/P2-3:`branch_started_at` 是「子树 max(started_at)」的
      // 物化值,此前只有铸行点向上推进(单调 MAX),删掉一个子任务后父行会**永久**
      // 停在被删子树的时间戳上。可观察后果:同一份数据在默认视图(快路径按物化列
      // 排序)与任一过滤视图(旧管线现算)之间行序不同且永不收敛。
      // 删除是低频操作,在同一事务里沿父链重算即可闭合(链长同 MAX_TREE_DEPTH)。
      let cursor: string | null = row.parentTaskId
      for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
        const parent = tx
          .select({
            id: tasks.id,
            parentTaskId: tasks.parentTaskId,
            startedAt: tasks.startedAt,
          })
          .from(tasks)
          .where(eq(tasks.id, cursor))
          .get()
        if (parent === undefined) break
        const childMax = tx
          .select({ v: sql<number | null>`MAX(${tasks.branchStartedAt})` })
          .from(tasks)
          .where(eq(tasks.parentTaskId, parent.id))
          .get()
        const recomputed = Math.max(parent.startedAt ?? 0, childMax?.v ?? 0)
        tx.update(tasks).set({ branchStartedAt: recomputed }).where(eq(tasks.id, parent.id)).run()
        cursor = parent.parentTaskId
      }
    })
  } finally {
    release()
  }

  // Best-effort disk cleanup (GC orphan-scan is the backstop).
  let cleanup: 'done' | 'pending' = 'done'
  const fail = (what: string, err: unknown): void => {
    cleanup = 'pending'
    log.warn('task delete cleanup step failed', {
      taskId,
      what,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  // RFC-243 §4.4 — an 'inherited' child's workspace IS the parent's call-node
  // iso; removing it here would rip the directory out of the parent's iso
  // lifecycle (discard / GC own it). Skip worktree + snapshot-ref cleanup,
  // keep the runs/logs/scratch sweep below.
  const ownsWorkspace = row.spaceKind !== 'inherited'
  for (const wt of ownsWorkspace ? worktrees : []) {
    try {
      await removeWorktree({ repoPath: wt.repoPath, worktreePath: wt.worktreePath, force: true })
    } catch (err) {
      fail('removeWorktree', err)
      try {
        if (existsSync(wt.worktreePath)) rmSync(wt.worktreePath, { recursive: true, force: true })
      } catch (err2) {
        fail('rmSync-worktree', err2)
      }
    }
    try {
      await deleteSnapshotRefs(wt.repoPath, taskId)
    } catch (err) {
      fail('deleteSnapshotRefs', err)
    }
  }
  for (const dir of [
    join(Paths.runsDir, taskId),
    join(Paths.logsDir, taskId),
    join(Paths.root, 'scratch', taskId),
  ]) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      fail('rmSync-dir', err)
    }
  }
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
  return { taskId, cleanup }
}

/**
 * RFC-243 §4.4 — BFS over parent_task_id for any non-terminal descendant.
 * Depth is bounded by maxInvocationDepth at launch time; the walk is defensive
 * against dirty data via a visited set.
 */
async function findNonTerminalDescendant(
  db: DbClient,
  rootId: string,
): Promise<{ id: string; status: string } | null> {
  const visited = new Set<string>([rootId])
  let frontier = [rootId]
  while (frontier.length > 0) {
    const children = await db
      .select({ id: tasks.id, status: tasks.status, parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(inArray(tasks.parentTaskId, frontier))
    frontier = []
    for (const c of children) {
      if (visited.has(c.id)) continue
      visited.add(c.id)
      if (!isTerminalTaskStatus(c.status as TaskStatus)) return { id: c.id, status: c.status }
      frontier.push(c.id)
    }
  }
  return null
}
