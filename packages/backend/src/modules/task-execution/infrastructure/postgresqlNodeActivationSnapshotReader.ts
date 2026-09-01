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
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
      })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  }

  async findOutputActivation(nodeRunId: string): Promise<ReadonlyMap<string, boolean>> {
    const rows = await this.db
      .select({ portName: nodeRunOutputs.portName, active: nodeRunOutputs.active })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    return new Map(rows.map((row) => [row.portName, row.active]))
  }
}
