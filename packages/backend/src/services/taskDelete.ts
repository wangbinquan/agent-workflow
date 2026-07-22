// RFC-222 (B 线) — admin-only hard delete of a terminal task.
//
// Route gate is requirePermission('tasks:delete') (admin only). This service
// owns the rest of the contract:
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
//   task_feedback is deleted explicitly (no FK, task-scoped). memory_distill_jobs
//   / recovery_events / lifecycle_repair_audit are RETAINED (memory / DR /
//   append-only audit — they outlive the task, dangling taskId is intended).
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

import { eq } from 'drizzle-orm'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { taskFeedback, taskRepos, tasks } from '@/db/schema'
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

  // Capture every worktree BEFORE deletion (taskRepos cascades away with the row).
  const repoRows = await db
    .select({ repoPath: taskRepos.repoPath, worktreePath: taskRepos.worktreePath })
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
  const worktrees: WorktreeTarget[] = repoRows.length
    ? repoRows.map((r) => ({ repoPath: r.repoPath, worktreePath: r.worktreePath }))
    : [{ repoPath: row.repoPath, worktreePath: row.worktreePath }]

  // Serialize against in-flight writers, then re-check terminality and delete in
  // one transaction (closes the resume/retry TOCTOU — §6.2).
  const release = await getTaskWriteSem(taskId).acquire()
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
      // Explicit non-FK task-scoped delete; the 12 FK tables cascade with the row.
      tx.delete(taskFeedback).where(eq(taskFeedback.taskId, taskId)).run()
      tx.delete(tasks).where(eq(tasks.id, taskId)).run()
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
  for (const wt of worktrees) {
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

  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, { type: 'task.deleted', taskId })
  return { taskId, cleanup }
}
