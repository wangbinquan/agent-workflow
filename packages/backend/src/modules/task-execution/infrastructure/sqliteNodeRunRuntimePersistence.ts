import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import type { NodeRunRuntimePersistence } from '../application/ports/nodeRunRuntimePersistence'
import { withCurrentTaskExecutionMutation } from './sqliteOwnedTaskMutation'

const projection = {
  runtime: nodeRuns.runtime,
  runtimeBinary: nodeRuns.runtimeBinary,
  runtimeParamsJson: nodeRuns.runtimeParamsJson,
}

export class SqliteNodeRunRuntimePersistence implements NodeRunRuntimePersistence {
  constructor(private readonly db: DbClient) {}

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
    withCurrentTaskExecutionMutation({
      db: this.db,
      run: (tx) => {
        tx.update(nodeRuns)
          .set({
            runtime: input.runtime,
            runtimeBinary: input.runtimeBinary,
            runtimeParamsJson: input.runtimeParamsJson,
          })
          .where(eq(nodeRuns.id, input.nodeRunId))
          .run()
      },
    })
  }
}
