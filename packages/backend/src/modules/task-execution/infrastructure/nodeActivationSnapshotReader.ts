// RFC-359 W4-B1 —— 节点激活快照读取：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份只差客户端类型与同步 / 异步形态）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { NodeActivationSnapshotReader } from '../application/ports/nodeActivationSnapshotReader'

export class DrizzleNodeActivationSnapshotReader implements NodeActivationSnapshotReader {
  constructor(private readonly db: PersistenceDb) {}

  async findRuns(taskId: string, nodeId: string) {
    const { nodeRuns } = tablesOf(this.db)
    return await this.db
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        containerRunId: nodeRuns.containerRunId,
      })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  }

  async findRun(nodeRunId: string) {
    const { nodeRuns } = tablesOf(this.db)
    const rows = await this.db
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        containerRunId: nodeRuns.containerRunId,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0] ?? null
  }

  async findOutputActivation(nodeRunId: string): Promise<ReadonlyMap<string, boolean>> {
    const { nodeRunOutputs } = tablesOf(this.db)
    const rows = await this.db
      .select({ portName: nodeRunOutputs.portName, active: nodeRunOutputs.active })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    return new Map(rows.map((row) => [row.portName, row.active]))
  }
}
