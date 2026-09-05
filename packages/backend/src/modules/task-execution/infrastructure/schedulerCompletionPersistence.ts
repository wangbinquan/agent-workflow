// RFC-359 W4-B1 —— 调度器收尾读写：一份实现，两个 provider 共用。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskRepos } from '@/db/schema'
import type { SchedulerCompletionPersistence } from '../application/ports/schedulerCompletionPersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

export class DrizzleSchedulerCompletionPersistence implements SchedulerCompletionPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async recordReadonlyDirty(
    input: Parameters<SchedulerCompletionPersistence['recordReadonlyDirty']>[0],
  ): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      await fenceTaskWrite(tx, { taskId: input.taskId, context: input.execution, now: input.now })
      await tx
        .update(taskRepos)
        .set({ readonlyDirtyCount: input.changedCount })
        .where(and(eq(taskRepos.taskId, input.taskId), eq(taskRepos.repoIndex, input.repoIndex)))
        .run()
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
