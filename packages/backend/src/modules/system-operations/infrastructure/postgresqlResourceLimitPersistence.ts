import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { nodeRuns, recoveryEvents, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { bumpRecoveryCounter } from '@/services/recovery'
import { createLogger } from '@/util/log'
import {
  decodeResourceLimitTokenTotal,
  type ResourceLimitCancellationAudit,
  type ResourceLimitCallRow,
  type ResourceLimitPersistence,
  type ResourceLimitTask,
  type ResourceLimitTaskClock,
} from '../application/ports/resourceLimitPersistence'

const log = createLogger('postgresql-resource-limits')

export class PostgresqlResourceLimitPersistence implements ResourceLimitPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async listRunningTasks(): Promise<ReadonlyArray<ResourceLimitTask>> {
    return await this.db
      .select({
        id: tasks.id,
        maxDurationMs: tasks.maxDurationMs,
        maxTotalTokens: tasks.maxTotalTokens,
        runningMs: tasks.runningMs,
        runningSince: tasks.runningSince,
      })
      .from(tasks)
      .where(eq(tasks.status, 'running'))
      .all()
  }

  async listCallRows(taskId: string): Promise<ReadonlyArray<ResourceLimitCallRow>> {
    return await this.db
      .select({
        childTaskId: nodeRuns.childTaskId,
        wrapperProgressJson: nodeRuns.wrapperProgressJson,
      })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRuns.childTaskId)))
      .all()
  }

  async listTaskStatuses(taskIds: readonly string[]): Promise<ReadonlyArray<string>> {
    if (taskIds.length === 0) return []
    return (
      await this.db
        .select({ status: tasks.status })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
        .all()
    ).map((row) => row.status)
  }

  async sumTaskTokens(taskId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number | null>`sum(${nodeRuns.tokTotal})` })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .all()
    return decodeResourceLimitTokenTotal(rows[0]?.total)
  }

  async readTaskClock(taskId: string): Promise<ResourceLimitTaskClock | null> {
    return (
      (await this.db
        .select({ runningMs: tasks.runningMs, runningSince: tasks.runningSince })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()) ?? null
    )
  }

  async writeLimitReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<void> {
    await this.db
      .update(tasks)
      .set({ errorSummary: input.summary, errorMessage: input.message })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.status, 'canceled')))
      .run()
  }

  async recordLimitCancellation(input: ResourceLimitCancellationAudit): Promise<void> {
    bumpRecoveryCounter('limit-cancel')
    try {
      await this.db
        .insert(recoveryEvents)
        .values({
          id: ulid(),
          taskId: input.taskId,
          nodeRunId: null,
          actor: 'system',
          kind: 'limit-cancel',
          reason: input.reason,
          beforeJson: JSON.stringify({ status: 'running' }),
          afterJson: JSON.stringify({ status: 'canceled' }),
          createdAt: input.now,
        })
        .run()
    } catch (error) {
      log.warn('resource-limit recovery audit dropped', { error: String(error) })
    }
  }
}
