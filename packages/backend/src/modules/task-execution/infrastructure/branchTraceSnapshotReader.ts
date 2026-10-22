// RFC-359 W4-B1 —— 分支追踪快照读取：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份逐字相同）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { BranchTraceSnapshotReader } from '../application/ports/branchTraceSnapshotReader'

export class DrizzleBranchTraceSnapshotReader implements BranchTraceSnapshotReader {
  constructor(private readonly db: PersistenceDb) {}

  async read(taskId: string) {
    const { tasks, nodeRuns, nodeRunOutputs } = tablesOf(this.db)
    const taskRows = await this.db
      .select({ workflowSnapshot: tasks.workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (task === undefined) return null
    const runs = await this.db
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        shardKey: nodeRuns.shardKey,
        errorMessage: nodeRuns.errorMessage,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    const outputs = await this.db
      .select({
        nodeRunId: nodeRunOutputs.nodeRunId,
        portName: nodeRunOutputs.portName,
        content: nodeRunOutputs.content,
        active: nodeRunOutputs.active,
      })
      .from(nodeRunOutputs)
      .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
      .where(eq(nodeRuns.taskId, taskId))
    return { workflowSnapshot: task.workflowSnapshot, runs, outputs }
  }
}
