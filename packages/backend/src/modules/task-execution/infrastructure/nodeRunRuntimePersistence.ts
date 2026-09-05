// RFC-359 W4-B1 —— node run 冻结运行时持久化：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'

const projection = {
  runtime: nodeRuns.runtime,
  runtimeBinary: nodeRuns.runtimeBinary,
  runtimeParamsJson: nodeRuns.runtimeParamsJson,
}

export class DrizzleNodeRunRuntimePersistence implements NodeRunRuntimePersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async load(nodeRunId: string) {
    const rows = await this.db
      .select(projection)
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0] ?? null
  }

  async findBySessionId(sessionId: string) {
    const rows = await this.db
      .select(projection)
      .from(nodeRuns)
      .where(eq(nodeRuns.opencodeSessionId, sessionId))
      .limit(1)
    return rows[0] ?? null
  }

  async freeze(input: Parameters<NodeRunRuntimePersistence['freeze']>[0]): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      const rows = await tx
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return
      await fenceTaskWrite(tx, { taskId: row.taskId })
      await tx
        .update(nodeRuns)
        .set({
          runtime: input.runtime,
          runtimeBinary: input.runtimeBinary,
          runtimeParamsJson: input.runtimeParamsJson,
        })
        .where(eq(nodeRuns.id, input.nodeRunId))
        .run()
    })
  }
}
