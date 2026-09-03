import { and, desc, eq, isNull } from 'drizzle-orm'

import { nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { pickFrameSourceRun } from '@/services/freshness'
import type { WrapperRunPersistence } from '../application/ports/wrapperRunPersistence'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'
import { clearReuseDisabledProgress, wrapperRunSnapshot } from './wrapperRunPersistenceShared'

export class PostgresqlWrapperRunPersistence implements WrapperRunPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async findResumable(
    input: Parameters<WrapperRunPersistence['findResumable']>[0],
  ): ReturnType<WrapperRunPersistence['findResumable']> {
    const rows = await this.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.nodeId, input.nodeId),
          // RFC-354: a generation is keyed by its frame, not by iteration alone.
          input.containerRunId === null
            ? isNull(nodeRuns.containerRunId)
            : eq(nodeRuns.containerRunId, input.containerRunId),
          eq(nodeRuns.iteration, input.iteration),
        ),
      )
      .orderBy(desc(nodeRuns.id))
      .limit(1)
    const row = rows[0]
    if (
      row === undefined ||
      row.status === 'done' ||
      row.status === 'failed' ||
      row.status === 'exhausted'
    ) {
      return null
    }
    return { id: row.id, status: row.status, previous: wrapperRunSnapshot(row) }
  }

  async resolveConsumed(
    input: Parameters<WrapperRunPersistence['resolveConsumed']>[0],
  ): ReturnType<WrapperRunPersistence['resolveConsumed']> {
    const consumed: Record<string, string> = {}
    for (const source of input.sources) {
      const rows = await this.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.nodeId, source.nodeId)))
      const run = pickFrameSourceRun(rows, source.frame)
      if (run !== undefined) consumed[source.nodeId] = run.id
    }
    return consumed
  }

  async readStatus(nodeRunId: string) {
    return (
      (
        await this.db
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .limit(1)
      )[0]?.status ?? null
    )
  }

  async clearReuseDisabled(
    input: Parameters<WrapperRunPersistence['clearReuseDisabled']>[0],
  ): Promise<void> {
    await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const rows = await tx
        .select({
          taskId: nodeRuns.taskId,
          wrapperProgressJson: nodeRuns.wrapperProgressJson,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return
      if (input.executionContext === undefined) {
        await assertPostgresqlTaskOwnerlessTx(tx, row.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(tx, input.executionContext.token, Date.now())
      }
      const next = clearReuseDisabledProgress(row.wrapperProgressJson)
      if (next === null) return
      await tx
        .update(nodeRuns)
        .set({ wrapperProgressJson: next })
        .where(eq(nodeRuns.id, input.nodeRunId))
        .run()
    })
  }
}
