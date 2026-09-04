// RFC-359 W1-T7c —— 任务删除认领的崩溃恢复：**一份**实现，两个引擎共用。
//
// 此前 `services/taskDelete.ts` 的 `recoverInterruptedTaskDeletes` 形参是 `LegacySqliteTaskDatabase`，
// 事务体用 dbTxSync + SQLite 递归 CTE，认领推进走 SQLite 同步 store——PostgreSQL daemon 就算修好
// 启动序列也接不上：一次 daemon 崩溃留下的 delete 认领在 PG 上永远没人续做，成员任务永久占位
// （dual-provider-parity-audit-2026-09-04 T7c）。这里按 `ProviderNeutralDatabase` +
// `TerminalMaintenanceStore` 端口重写一次；级联树用 parent_task_id 的 BFS（与 snapshotTree 同形），
// 事务开头锁认领行（PG `FOR UPDATE`，SQLite no-op）。清理计划的解析与磁盘清理是纯 I/O，随之搬入。

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import { asc, eq, inArray, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskCollaborators, taskExecutionMaintenanceClaims, taskFeedback, tasks } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { ConflictError } from '@/util/errors'
import { deleteSnapshotRefs, removeWorktree } from '@/util/git'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import type { TerminalMaintenanceStore } from '../application/ports/terminalMaintenanceStore'
import type { TerminalMaintenanceClaim } from '../domain/ownership'
import type { MaintenanceMemberSnapshot } from '../domain/terminalMaintenance'
import { createTaskExecutionPersistence } from '../composition/taskExecutionPersistence'
import {
  assertTerminalMaintenanceClaimTx,
  transitionTerminalMaintenanceClaimTx,
} from './terminalMaintenanceClaim'

const log = createLogger('task-delete')

/** A worktree the deleted task owned — captured BEFORE the row (and its
 *  cascade) vanish, so the post-tx cleanup still knows what to reap. */
export interface DeleteWorktreeTarget {
  readonly repoPath: string
  readonly worktreePath: string
}

export interface DeleteCleanupPlanV2 {
  readonly v: 2
  readonly taskId: string
  readonly parentTaskId: string | null
  readonly worktrees: readonly DeleteWorktreeTarget[]
  readonly directories: readonly string[]
}

export interface DeleteRecoveryResult {
  readonly completed: readonly string[]
  readonly cleanupPending: readonly string[]
  readonly recoveryRequired: readonly string[]
}

export function parseDeleteCleanupPlan(
  value: string,
  members: readonly MaintenanceMemberSnapshot[],
): DeleteCleanupPlanV2 | null {
  try {
    const parsed = JSON.parse(value) as {
      v?: number
      taskId?: unknown
      parentTaskId?: unknown
      worktrees?: unknown
      directories?: unknown
    }
    if (
      (parsed.v !== 1 && parsed.v !== 2) ||
      typeof parsed.taskId !== 'string' ||
      !Array.isArray(parsed.worktrees) ||
      !parsed.worktrees.every(
        (target) =>
          target !== null &&
          typeof target === 'object' &&
          typeof (target as DeleteWorktreeTarget).repoPath === 'string' &&
          typeof (target as DeleteWorktreeTarget).worktreePath === 'string',
      ) ||
      !Array.isArray(parsed.directories) ||
      !parsed.directories.every((dir) => typeof dir === 'string')
    ) {
      return null
    }
    const directories =
      parsed.v === 2
        ? (parsed.directories as string[])
        : members.flatMap((member) => [
            join(Paths.runsDir, member.taskId),
            join(Paths.logsDir, member.taskId),
            join(Paths.root, 'scratch', member.taskId),
          ])
    return {
      v: 2,
      taskId: parsed.taskId,
      parentTaskId: typeof parsed.parentTaskId === 'string' ? parsed.parentTaskId : null,
      worktrees: parsed.worktrees as DeleteWorktreeTarget[],
      directories,
    }
  } catch {
    return null
  }
}

/** Best-effort disk cleanup after the row is gone: worktrees + snapshot refs + scratch dirs. */
export async function cleanupDeletedTaskResources(
  plan: DeleteCleanupPlanV2,
): Promise<'done' | 'pending'> {
  let cleanup: 'done' | 'pending' = 'done'
  const fail = (what: string, err: unknown): void => {
    cleanup = 'pending'
    log.warn('task delete cleanup step failed', {
      taskId: plan.taskId,
      what,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  for (const wt of plan.worktrees) {
    try {
      await removeWorktree({ repoPath: wt.repoPath, worktreePath: wt.worktreePath, force: true })
    } catch (err) {
      fail('removeWorktree', err)
      try {
        if (existsSync(wt.worktreePath)) rmSync(wt.worktreePath, { recursive: true, force: true })
      } catch (fallbackError) {
        fail('rmSync-worktree', fallbackError)
      }
    }
    try {
      await deleteSnapshotRefs(wt.repoPath, plan.taskId)
    } catch (err) {
      fail('deleteSnapshotRefs', err)
    }
  }
  for (const dir of plan.directories) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      fail('rmSync-dir', err)
    }
  }
  return cleanup
}

interface DeletedAudience {
  readonly taskId: string
  readonly visibleUserIds: ReadonlySet<string>
}

/**
 * The DB half of a resumed delete: re-check terminal status, prove the claimed member set is still
 * exactly the cascade tree, drop the root row (FK cascade takes the tree), bubble
 * `branch_started_at` up the ancestor chain and advance the claim to db-finalized — one transaction.
 */
async function finalizeDeleteRowsTx(input: {
  readonly db: ProviderNeutralDatabase
  readonly claim: TerminalMaintenanceClaim
  readonly rootTaskId: string
  readonly members: readonly MaintenanceMemberSnapshot[]
  readonly plan: DeleteCleanupPlanV2
}): Promise<{ claim: TerminalMaintenanceClaim; audiences: readonly DeletedAudience[] }> {
  return await databaseSessionFor(input.db).transaction(async (tx) => {
    await engineOf(tx).lockAggregateRoot(
      tx,
      taskExecutionMaintenanceClaims,
      taskExecutionMaintenanceClaims.id,
      input.claim.claimId,
    )
    await assertTerminalMaintenanceClaimTx(tx, {
      claim: input.claim,
      expectedState: 'io-complete',
    })
    const fresh = (
      await tx
        .select({
          status: tasks.status,
          parentTaskId: tasks.parentTaskId,
          ownerUserId: tasks.ownerUserId,
        })
        .from(tasks)
        .where(eq(tasks.id, input.rootTaskId))
        .limit(1)
    )[0]
    let audiences: DeletedAudience[] = []
    if (fresh !== undefined) {
      if (!isTerminalTaskStatus(fresh.status as TaskStatus)) {
        throw new ConflictError(
          'task-terminal-maintenance-conflict',
          `task '${input.rootTaskId}' changed during delete recovery`,
        )
      }
      // 级联树：parent_task_id 的 BFS（与 snapshotTree 同形），不依赖任一方言的递归 CTE。
      const cascadeRows: Array<{ id: string; ownerUserId: string | null }> = [
        { id: input.rootTaskId, ownerUserId: fresh.ownerUserId },
      ]
      const seen = new Set([input.rootTaskId])
      let frontier = [input.rootTaskId]
      while (frontier.length > 0) {
        const children = await tx
          .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
          .from(tasks)
          .where(inArray(tasks.parentTaskId, frontier))
          .orderBy(asc(tasks.id))
        const next: string[] = []
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          cascadeRows.push(child)
          next.push(child.id)
        }
        frontier = next
      }
      const cascadeIds = cascadeRows.map((row) => row.id)
      const claimedIds = input.members.map((member) => member.taskId).sort()
      if (JSON.stringify([...cascadeIds].sort()) !== JSON.stringify(claimedIds)) {
        throw new ConflictError(
          'task-terminal-maintenance-conflict',
          `task tree '${input.rootTaskId}' changed during delete recovery`,
        )
      }
      const collaborators = await tx
        .select({ taskId: taskCollaborators.taskId, userId: taskCollaborators.userId })
        .from(taskCollaborators)
        .where(inArray(taskCollaborators.taskId, cascadeIds))
      audiences = cascadeRows.map((row) => {
        const visibleUserIds = new Set<string>()
        if (row.ownerUserId !== null) visibleUserIds.add(row.ownerUserId)
        for (const collaborator of collaborators) {
          if (collaborator.taskId === row.id) visibleUserIds.add(collaborator.userId)
        }
        return { taskId: row.id, visibleUserIds }
      })
      await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, cascadeIds)).run()
      await tx.delete(tasks).where(eq(tasks.id, input.rootTaskId)).run()

      let cursor = fresh.parentTaskId ?? input.plan.parentTaskId
      for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
        const parent = (
          await tx
            .select({ id: tasks.id, parentTaskId: tasks.parentTaskId, startedAt: tasks.startedAt })
            .from(tasks)
            .where(eq(tasks.id, cursor))
            .limit(1)
        )[0]
        if (parent === undefined) break
        const childMax = (
          await tx
            .select({ v: sql<number | null>`MAX(${tasks.branchStartedAt})` })
            .from(tasks)
            .where(eq(tasks.parentTaskId, parent.id))
        )[0]
        await tx
          .update(tasks)
          .set({ branchStartedAt: Math.max(parent.startedAt ?? 0, childMax?.v ?? 0) })
          .where(eq(tasks.id, parent.id))
          .run()
        cursor = parent.parentTaskId
      }
    }
    const claim = await transitionTerminalMaintenanceClaimTx(tx, {
      claim: input.claim,
      to: 'db-finalized',
      now: Date.now(),
    })
    return { claim, audiences }
  })
}

/** Resume exact RFC-328 delete claims left by a daemon/process crash. */
export async function recoverInterruptedTaskDeletes(
  db: ProviderNeutralDatabase,
  terminalMaintenance: TerminalMaintenanceStore = createTaskExecutionPersistence(db)
    .terminalMaintenance,
): Promise<DeleteRecoveryResult> {
  const completed: string[] = []
  const cleanupPending: string[] = []
  const recoveryRequired: string[] = []
  for (const item of await terminalMaintenance.listRecoverable({ operation: 'delete' })) {
    const plan = parseDeleteCleanupPlan(item.cleanupPlanJson, item.members)
    let claim: TerminalMaintenanceClaim = item.claim
    let state = item.state
    if (plan === null) {
      if (state !== 'recovery-required') {
        await terminalMaintenance.transition({ claim, to: 'recovery-required' })
      }
      recoveryRequired.push(item.rootTaskId)
      continue
    }

    const rootBefore = (
      await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, item.rootTaskId)).limit(1)
    )[0]
    if (state === 'recovery-required') {
      const to = rootBefore === undefined ? 'db-finalized' : 'io-complete'
      claim = await terminalMaintenance.transition({ claim, to })
      state = to
    } else if (state === 'claimed') {
      claim = await terminalMaintenance.transition({ claim, to: 'io-complete' })
      state = 'io-complete'
    }

    let audiences: readonly DeletedAudience[] = []
    if (state === 'io-complete') {
      const release = await getTaskWriteSem(item.rootTaskId).acquire()
      try {
        const finalized = await finalizeDeleteRowsTx({
          db,
          claim,
          rootTaskId: item.rootTaskId,
          members: item.members,
          plan,
        })
        claim = finalized.claim
        audiences = finalized.audiences
      } finally {
        release()
      }
      state = 'db-finalized'
      for (const audience of audiences) {
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
    }

    if (state === 'db-finalized' || state === 'cleanup-pending') {
      const cleanup = await cleanupDeletedTaskResources(plan)
      if (cleanup === 'done') {
        await terminalMaintenance.complete({ claim })
        completed.push(item.rootTaskId)
      } else {
        if (state === 'db-finalized') {
          await terminalMaintenance.transition({ claim, to: 'cleanup-pending' })
        }
        cleanupPending.push(item.rootTaskId)
      }
    }
  }
  return { completed, cleanupPending, recoveryRequired }
}
