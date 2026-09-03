import { and, eq } from 'drizzle-orm'
import { nodeRunOutputs, nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { NodeActivationSnapshotReader } from '../application/ports/nodeActivationSnapshotReader'

export class PostgresqlNodeActivationSnapshotReader implements NodeActivationSnapshotReader {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

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
