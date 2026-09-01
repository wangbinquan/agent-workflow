import { and, eq, inArray } from 'drizzle-orm'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'

import { taskExecutionOwners, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionShutdownOperations } from '../application/ports/taskExecutionShutdownOperations'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'

export class PostgresqlTaskExecutionShutdownOperations implements TaskExecutionShutdownOperations {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async listRunningTaskIds(): Promise<readonly string[]> {
    return (
      await this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'running'))
    ).map((row) => row.id)
  }

  async interruptSurvivor(
    input: Parameters<TaskExecutionShutdownOperations['interruptSurvivor']>[0],
  ): Promise<boolean> {
    const eventRefs = await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const current = (
        await tx
          .select({ lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'running')))
          .limit(1)
      )[0]
      if (current === undefined) return null
      const nextRevision = current.lifecycleEventRevision + 1
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
      await terminalizePostgresqlTaskExecutionIntentsTx(tx, {
        taskId: input.taskId,
        state: 'failed',
        failureCode: 'daemon-shutdown-survivor',
        now: input.now,
      })
      const event = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
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
    await this.db
      .update(taskExecutionOwners)
      .set({
        state: 'recovery-required',
        recoveryCode: input.recoveryCode,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionOwners.taskId, input.taskId),
          inArray(taskExecutionOwners.state, ['claimed', 'revoked']),
        ),
      )
      .run()
  }
}
