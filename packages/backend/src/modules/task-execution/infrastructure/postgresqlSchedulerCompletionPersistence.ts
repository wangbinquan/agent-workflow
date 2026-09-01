import { and, eq } from 'drizzle-orm'

import { nodeRuns, taskRepos } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { SchedulerCompletionPersistence } from '../application/ports/schedulerCompletionPersistence'
import {
  assertPostgresqlTaskOwnerTx,
  assertPostgresqlTaskOwnerlessTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

export class PostgresqlSchedulerCompletionPersistence implements SchedulerCompletionPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async recordReadonlyDirty(
    input: Parameters<SchedulerCompletionPersistence['recordReadonlyDirty']>[0],
  ): Promise<void> {
    await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      if (input.execution === undefined) {
        await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(tx, input.execution.token, input.now)
      }
      await tx
        .update(taskRepos)
        .set({ readonlyDirtyCount: input.changedCount })
        .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
    })
  }

  async listDoneNodeRuns(input: Parameters<SchedulerCompletionPersistence['listDoneNodeRuns']>[0]) {
    return await this.db
      .select({
        id: nodeRuns.id,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        status: nodeRuns.status,
      })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.iteration, input.iteration),
          eq(nodeRuns.status, 'done'),
        ),
      )
  }
}
