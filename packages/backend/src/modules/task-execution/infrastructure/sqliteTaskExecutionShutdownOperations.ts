import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskExecutionOwners, tasks } from '@/db/schema'
import type { TaskExecutionShutdownOperations } from '../application/ports/taskExecutionShutdownOperations'
import { setTaskStatus } from '@/services/lifecycle'
import { terminalizeTaskExecutionIntentsTx } from './sqliteTerminalizeExecutionIntent'

function changed(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

export class SqliteTaskExecutionShutdownOperations implements TaskExecutionShutdownOperations {
  constructor(private readonly db: DbClient) {}

  async listRunningTaskIds(): Promise<readonly string[]> {
    return (
      await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'running'))
    ).map((row) => row.id)
  }

  async interruptSurvivor(
    input: Parameters<TaskExecutionShutdownOperations['interruptSurvivor']>[0],
  ): Promise<boolean> {
    try {
      await setTaskStatus({
        db: this.db,
        taskId: input.taskId,
        to: 'interrupted',
        allowedFrom: ['running'],
        extra: {
          finishedAt: input.now,
          errorSummary: 'daemon-restart',
          errorMessage: input.errorMessage,
        },
        now: input.now,
        onTransitionTx: (transitionTx) => {
          terminalizeTaskExecutionIntentsTx({
            tx: transitionTx,
            taskId: input.taskId,
            state: 'failed',
            failureCode: 'daemon-shutdown-survivor',
            now: input.now,
          })
        },
        reason: 'graceful-shutdown',
      })
      return true
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code
      if (
        code === 'concurrent-task-transition' ||
        code === 'task-not-found' ||
        code === 'illegal-task-transition'
      ) {
        return false
      }
      throw error
    }
  }

  async markRecoveryRequired(
    input: Parameters<TaskExecutionShutdownOperations['markRecoveryRequired']>[0],
  ): Promise<void> {
    const owner = (
      await this.db
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
    const result = await this.db
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
    if (changed(result) === 0) return
  }
}
