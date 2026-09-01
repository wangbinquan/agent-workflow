import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { BranchTraceSnapshotReader } from '../application/ports/branchTraceSnapshotReader'

export class SqliteBranchTraceSnapshotReader implements BranchTraceSnapshotReader {
  constructor(private readonly db: DbClient) {}

  async read(taskId: string) {
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
