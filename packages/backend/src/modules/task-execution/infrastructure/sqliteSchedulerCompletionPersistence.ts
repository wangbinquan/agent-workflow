import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns, taskRepos } from '@/db/schema'
import { withTaskExecutionMutation } from './sqliteOwnedTaskMutation'
import type { SchedulerCompletionPersistence } from '../application/ports/schedulerCompletionPersistence'

export class SqliteSchedulerCompletionPersistence implements SchedulerCompletionPersistence {
  constructor(private readonly db: DbClient) {}

  async recordReadonlyDirty(
    input: Parameters<SchedulerCompletionPersistence['recordReadonlyDirty']>[0],
  ): Promise<void> {
    withTaskExecutionMutation({
      db: this.db,
      taskId: input.taskId,
      ...(input.execution === undefined ? {} : { context: input.execution }),
      now: input.now,
      run: (tx) =>
        tx
          .update(taskRepos)
          .set({ readonlyDirtyCount: input.changedCount })
          .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
          .run(),
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
