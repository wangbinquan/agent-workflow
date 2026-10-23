// RFC-359 W4-B1 —— 调度器收尾读写：一份实现，两个 provider 共用。

import { createNodeRunQueries } from './nodeRunQueries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SchedulerCompletionPersistence } from '../application/ports/schedulerCompletionPersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

export class DrizzleSchedulerCompletionPersistence implements SchedulerCompletionPersistence {
  constructor(private readonly db: PersistenceDb) {}

  async recordReadonlyDirty(
    input: Parameters<SchedulerCompletionPersistence['recordReadonlyDirty']>[0],
  ): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      await fenceTaskWrite(tx, { taskId: input.taskId, context: input.execution, now: input.now })
      const { taskRepos } = tablesOf(tx)
      await tx
        .update(taskRepos)
        .set({ readonlyDirtyCount: input.changedCount })
        .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
    })
  }

  async listDoneNodeRuns(input: Parameters<SchedulerCompletionPersistence['listDoneNodeRuns']>[0]) {
    return createNodeRunQueries(this.db).listFields(
      {
        taskId: input.taskId,
        nodeId: input.nodeId,
        iteration: input.iteration,
        status: 'done',
      },
      ['id', 'seq', 'parentNodeRunId', 'status'],
    )
  }
}
