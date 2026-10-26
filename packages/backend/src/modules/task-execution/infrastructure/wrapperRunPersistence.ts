import { nodeOutputSlot } from '../domain/runSelection/nodeOutputSlot'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WrapperRunPersistence } from '../application/ports/wrapperRunPersistence'
import { createRunSelectionReader } from './runSelection/table/reader'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import { readNodeRunSnapshotRows } from './nodeRunSnapshot'
import { lockNodeRunTaskRootInTx, writeNodeRunTablesInTx } from './nodeRunWriteProtocol'
import { clearReuseDisabledProgress } from './wrapperRunPersistenceShared'

export class DrizzleWrapperRunPersistence implements WrapperRunPersistence {
  constructor(private readonly db: PersistenceDb) {}

  async findResumable(
    input: Parameters<WrapperRunPersistence['findResumable']>[0],
  ): ReturnType<WrapperRunPersistence['findResumable']> {
    const selected = await createRunSelectionReader(this.db).current(input.taskId, {
      kind: 'container',
      nodeId: input.nodeId,
      frame: { containerRunId: input.containerRunId, iteration: input.iteration },
    })
    if (selected === null || !selected.resumable) return null
    const rows = await readNodeRunSnapshotRows(this.db, selected.id)
    if (!rows) return null
    return {
      id: rows.run.id,
      status: rows.run.status,
      previous: {
        id: rows.run.id,
        status: rows.run.status,
        wrapperProgressJson: rows.runtime?.wrapperProgressJson ?? null,
        consumedUpstreamRunsJson: rows.run.inputsRecorded
          ? JSON.stringify(
              Object.fromEntries(
                rows.inputs.map((edge) => [edge.producerNodeId, edge.producerRunId]),
              ),
            )
          : null,
        mergeState: rows.runtime?.mergeState ?? null,
        checkpoints: rows.checkpoints,
        hasIsolationBase: rows.checkpoints.some(
          (checkpoint) => checkpoint.isolationBase !== undefined,
        ),
      },
    }
  }

  async resolveConsumed(
    input: Parameters<WrapperRunPersistence['resolveConsumed']>[0],
  ): ReturnType<WrapperRunPersistence['resolveConsumed']> {
    return databaseSessionFor(this.db).snapshotRead(async (tx) => {
      const consumed: Record<string, string> = {}
      const reader = createRunSelectionReader(tx)
      for (const source of input.sources) {
        const run = (
          await reader.slotHistory(
            input.taskId,
            nodeOutputSlot(source.nodeId, source.nodeKind, source.frame),
            { statusIn: ['done', 'skipped'], executableOnly: true },
          )
        ).at(-1)
        if (run) consumed[source.nodeId] = run.id
      }
      return consumed
    })
  }

  async readStatus(nodeRunId: string) {
    const { nodeRuns } = tablesOf(this.db)
    const [row] = await this.db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return row?.status ?? null
  }

  async clearReuseDisabled(
    input: Parameters<WrapperRunPersistence['clearReuseDisabled']>[0],
  ): Promise<void> {
    await withTaskExecutionWrite(this.db, async (tx) => {
      const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
      const [exists] = await tx
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.nodeRunId))
        .limit(1)
      if (!exists) return
      await fenceTaskWrite(tx, { taskId: exists.taskId, context: input.executionContext })
      await lockNodeRunTaskRootInTx(tx, input.nodeRunId)
      const [row] = await tx
        .select({ progress: nodeRunRuntimeStates.wrapperProgressJson })
        .from(nodeRunRuntimeStates)
        .where(eq(nodeRunRuntimeStates.nodeRunId, input.nodeRunId))
        .limit(1)
      const next = clearReuseDisabledProgress(row?.progress ?? null)
      if (next !== null)
        await writeNodeRunTablesInTx(tx, input.nodeRunId, {
          runtime: { wrapperProgressJson: next },
        })
    })
  }
}
