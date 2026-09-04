// RFC-359 W4-B1 —— 节点激活快照读取：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份只差客户端类型与同步 / 异步形态）。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunOutputs, nodeRuns } from '@/db/schema'
import type { NodeActivationSnapshotReader } from '../application/ports/nodeActivationSnapshotReader'

export class DrizzleNodeActivationSnapshotReader implements NodeActivationSnapshotReader {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async findRuns(taskId: string, nodeId: string) {
    return await this.db
      .select({
        id: nodeRuns.id,
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
    const rows = await this.db
      .select({
        id: nodeRuns.id,
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
    const rows = await this.db
      .select({ portName: nodeRunOutputs.portName, active: nodeRunOutputs.active })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    return new Map(rows.map((row) => [row.portName, row.active]))
  }
}
