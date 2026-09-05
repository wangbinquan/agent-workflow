// RFC-359 W4-B1 批 2h —— 优雅停机的幸存者处置：一份实现，两个 provider 共用。
//
// 此前 SQLite 走 legacy `setTaskStatus`（同步内核 + onTransitionTx 钩子），PG 内联 CAS + intent 终态化 +
// lifecycle committed event。两边都**不过 owner 围栏**：幸存者正是预算用尽后驱动仍活着的任务，owner 行还是
// `claimed`，这里是控制面的越权收场（下一次启动的孤儿收割也做同样的事），围栏在这条路上没有意义。

import { and, eq, inArray } from 'drizzle-orm'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionOwners, tasks } from '@/db/schema'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { TaskExecutionShutdownOperations } from '../application/ports/taskExecutionShutdownOperations'
import { withTaskExecutionWrite } from './ownedTaskExecution'
import { terminalizeTaskExecutionIntentsInTx } from './taskExecutionIntentTerminalPersistence'
import { appendTaskLifecycleTransitionCommittedEvent } from './taskLifecycleCommittedEvents'

export class DrizzleTaskExecutionShutdownOperations implements TaskExecutionShutdownOperations {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async listRunningTaskIds(): Promise<readonly string[]> {
    return (
      await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'running'))
    ).map((row) => row.id)
  }

  async interruptSurvivor(
    input: Parameters<TaskExecutionShutdownOperations['interruptSurvivor']>[0],
  ): Promise<boolean> {
    const eventRefs = await withTaskExecutionWrite(this.db, async (tx) => {
      const current = (
        await tx
          .select({ lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'running')))
          .limit(1)
      )[0]
      if (current === undefined) return null
      const nextRevision = current.lifecycleEventRevision + 1
      // rfc097-allow-direct-task-status-write -- 停机幸存者的控制面 CAS（s14 清单登记）
      const updated = await tx
        .update(tasks)
        .set({
          status: 'interrupted',
          finishedAt: input.now,
          errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
          errorMessage: input.errorMessage,
          lifecycleEventRevision: nextRevision,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, 'running'),
            eq(tasks.lifecycleEventRevision, current.lifecycleEventRevision),
          ),
        )
        .returning({ id: tasks.id })
      if (updated[0] === undefined) return null
      await terminalizeTaskExecutionIntentsInTx(tx, {
        taskId: input.taskId,
        state: 'failed',
        failureCode: 'daemon-shutdown-survivor',
        now: input.now,
      })
      const event = await appendTaskLifecycleTransitionCommittedEvent(tx, {
        taskId: input.taskId,
        lifecycleRevision: nextRevision,
        previousStatus: 'running',
        status: 'interrupted',
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        workspacePruneClaim: null,
        occurredAt: input.now,
      })
      return event === null ? [] : [event]
    })
    if (eventRefs === null) return false
    await publishCommittedEventsAfterCommit(eventRefs)
    return true
  }

  async markRecoveryRequired(
    input: Parameters<TaskExecutionShutdownOperations['markRecoveryRequired']>[0],
  ): Promise<void> {
    // 取 SQLite 的形状：按精确 owner 元组 + revision 做 CAS 并推进 revision（PG 此前是按状态过滤的裸 UPDATE）。
    await withTaskExecutionWrite(this.db, async (tx) => {
      const owner = (
        await tx
          .select({
            taskId: taskExecutionOwners.taskId,
            ownerId: taskExecutionOwners.ownerId,
            daemonGeneration: taskExecutionOwners.daemonGeneration,
            epoch: taskExecutionOwners.epoch,
            state: taskExecutionOwners.state,
            revision: taskExecutionOwners.revision,
          })
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, input.taskId))
          .limit(1)
      )[0]
      if (owner === undefined || (owner.state !== 'claimed' && owner.state !== 'revoked')) return
      await tx
        .update(taskExecutionOwners)
        .set({
          state: 'recovery-required',
          revision: owner.revision + 1,
          recoveryCode: input.recoveryCode,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, owner.taskId),
            eq(taskExecutionOwners.ownerId, owner.ownerId),
            eq(taskExecutionOwners.daemonGeneration, owner.daemonGeneration),
            eq(taskExecutionOwners.epoch, owner.epoch),
            eq(taskExecutionOwners.revision, owner.revision),
            inArray(taskExecutionOwners.state, ['claimed', 'revoked']),
          ),
        )
        .run()
    })
  }
}
