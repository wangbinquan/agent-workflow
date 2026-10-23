// RFC-359 W4-B1 —— wrapper run 持久化：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, isNull } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { runHistoryOrder } from '@/platform/persistence/runHistoryOrder'
import { createRunSelectionOracleSnapshot } from './runSelection/oracle/snapshot'
import type { WrapperRunPersistence } from '../application/ports/wrapperRunPersistence'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import { taskCheckpointMountPaths } from './taskCheckpointPersistence'
import { clearReuseDisabledProgress, wrapperRunSnapshot } from './wrapperRunPersistenceShared'

export class DrizzleWrapperRunPersistence implements WrapperRunPersistence {
  constructor(private readonly db: PersistenceDb) {}

  async findResumable(
    input: Parameters<WrapperRunPersistence['findResumable']>[0],
  ): ReturnType<WrapperRunPersistence['findResumable']> {
    const { nodeRuns } = tablesOf(this.db)
    const rows = await this.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.iteration, input.iteration),
          input.containerRunId === null
            ? isNull(nodeRuns.containerRunId)
            : eq(nodeRuns.containerRunId, input.containerRunId),
        ),
      )
      .orderBy(...runHistoryOrder(this.db, nodeRuns, 'seq', 'desc'))
      .limit(1)
    const selected = await createRunSelectionOracleSnapshot(rows, {
      scope: { kind: 'rows' },
    }).current(input.taskId, {
      kind: 'container',
      nodeId: input.nodeId,
      frame: { containerRunId: input.containerRunId, iteration: input.iteration },
    })
    if (selected === null || !selected.resumable) return null
    const row = rows.find((row) => row.id === selected.id)
    if (row === undefined) return null
    return {
      id: row.id,
      status: row.status,
      previous: wrapperRunSnapshot(row, await taskCheckpointMountPaths(this.db, input.taskId)),
    }
  }

  async resolveConsumed(
    input: Parameters<WrapperRunPersistence['resolveConsumed']>[0],
  ): ReturnType<WrapperRunPersistence['resolveConsumed']> {
    const consumed: Record<string, string> = {}
    for (const source of input.sources) {
      const { nodeRuns } = tablesOf(this.db)
      const rows = await this.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.nodeId, source.nodeId)))
      const run = (
        await createRunSelectionOracleSnapshot(rows, { scope: { kind: 'rows' } }).slotHistory(
          input.taskId,
          {
            kind: 'node',
            nodeId: source.nodeId,
            frame: source.frame,
          },
          { statusIn: ['done', 'skipped'] },
        )
      ).at(-1)
      if (run !== undefined) consumed[source.nodeId] = run.id
    }
    return consumed
  }

  async readStatus(nodeRunId: string) {
    const { nodeRuns } = tablesOf(this.db)
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
    await withTaskExecutionWrite(this.db, async (tx) => {
      const { nodeRuns } = tablesOf(tx)
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
      await fenceTaskWrite(tx, { taskId: row.taskId, context: input.executionContext })
      const next = clearReuseDisabledProgress(row.wrapperProgressJson)
      if (next === null) return
      await tx
        .update(nodeRuns)
        .set({ wrapperProgressJson: next })
        .where(eq(nodeRuns.id, input.nodeRunId))
    })
  }
}
