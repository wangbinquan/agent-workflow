import { and, desc, eq, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { pickFrameSourceRun } from '@/services/freshness'
import type { WrapperRunPersistence } from '../application/ports/wrapperRunPersistence'
import { withCurrentTaskExecutionMutation } from './sqliteOwnedTaskMutation'
import { clearReuseDisabledProgress, wrapperRunSnapshot } from './wrapperRunPersistenceShared'

export class SqliteWrapperRunPersistence implements WrapperRunPersistence {
  constructor(private readonly db: DbClient) {}

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
    const row = (
      await this.db
        .select({ wrapperProgressJson: nodeRuns.wrapperProgressJson })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
    )[0]
    const next = clearReuseDisabledProgress(row?.wrapperProgressJson ?? null)
    if (next === null) return
    withCurrentTaskExecutionMutation({
      db: this.db,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({ wrapperProgressJson: next })
          .where(eq(nodeRuns.id, input.nodeRunId))
          .run(),
    })
  }
}
