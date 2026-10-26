import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import { readDatabaseContent } from '@/platform/content/infrastructure/contentStore'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B1 —— 分支追踪快照读取：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份逐字相同）。

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { eq } from 'drizzle-orm'
import type {
  BranchTraceRunSnapshot,
  BranchTraceSnapshotReader,
} from '../application/ports/branchTraceSnapshotReader'
import { createRunSelectionReader } from './runSelection/table/reader'
import type { FamilyRef, HistoryFilter } from '../application/ports/runSelection'

export class DrizzleBranchTraceSnapshotReader implements BranchTraceSnapshotReader {
  constructor(
    private readonly db: PersistenceDb,
    private readonly content: Pick<ContentStore, 'read'> = {
      read: (ref) => readDatabaseContent(db, ref),
    },
  ) {}

  history(taskId: string, runs: readonly BranchTraceRunSnapshot[]) {
    const ids = new Set(runs.map((row) => row.id))
    return {
      familyHistory: (id: string, family: FamilyRef, filter?: HistoryFilter) => {
        if (id !== taskId) return Promise.resolve([])
        return createRunSelectionReader(this.db).familyHistory(
          id,
          {
            ...family,
            runIds: family.runIds?.filter((runId) => ids.has(runId)) ?? [...ids],
          },
          filter,
        )
      },
    }
  }

  async read(taskId: string) {
    const { nodeRuns, nodeRunOutputs } = tablesOf(this.db)
    const { tasks } = tablesOf(this.db)
    const taskRows = await this.db
      .select({ workflowSnapshot: taskReadColumns(this.db).workflowSnapshot })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const task = taskRows[0]
    if (task === undefined) return null
    const runs = await this.db
      .select({
        id: nodeRuns.id,
        seq: nodeRuns.seq,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.historicalParentId,
        shardKey: nodeRuns.shardKey,
        errorMessage: nodeRuns.errorMessage,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    const outputRows = await this.db
      .select({
        nodeRunId: nodeRunOutputs.nodeRunId,
        portName: nodeRunOutputs.portName,
        contentRefJson: nodeRunOutputs.contentRefJson,
        contentInlineBytes: nodeRunOutputs.contentInlineBytes,
        active: nodeRunOutputs.active,
      })
      .from(nodeRunOutputs)
      .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
      .where(eq(nodeRuns.taskId, taskId))
    const outputs = await Promise.all(
      outputRows.map(async ({ contentRefJson, contentInlineBytes, ...row }) => {
        const ref = contentRefColumns.decode(contentRefJson, contentInlineBytes)
        if (!ref) throw new Error('node-output-content-missing')
        return {
          ...row,
          content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(
            await this.content.read(ref),
          ),
        }
      }),
    )
    return { workflowSnapshot: task.workflowSnapshot, runs, outputs }
  }
}
