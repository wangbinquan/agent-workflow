import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WorkflowSyncPreviewReads } from '../application/ports/workflowSyncPreviewReads'
import { createNodeOutputQueries } from './nodeOutputQueries'
import { createNodeRunQueries } from './nodeRunQueries'
import { createRunSelectionReader } from './runSelection/table/reader'
import { createTaskTriggerQueries } from './taskTriggerQueries'

/**
 * RFC-478 —— 同步预览读端口的实现：四个读各取既有查询工厂，与原 `services/task.ts` 函数体里的四处调用一一对应
 * （选择读取器同样每次预览只建一个、各节点共用）。
 */
export function createWorkflowSyncPreviewReads(db: PersistenceDb): WorkflowSyncPreviewReads {
  const nodeRuns = createNodeRunQueries(db)
  const selection = createRunSelectionReader(db)
  const outputs = createNodeOutputQueries(db)
  const triggers = createTaskTriggerQueries(db)
  return Object.freeze({
    listNodeRuns: (taskId: string) => nodeRuns.list({ taskId }),
    async freshestDoneTopLevelRunId(taskId: string, nodeId: string) {
      const fresh = (
        await selection.familyHistory(
          taskId,
          { nodeId },
          { topLevelOnly: true, statusIn: ['done'] },
        )
      ).at(-1)
      return fresh?.id ?? null
    },
    producedPorts: (nodeRunIds: readonly string[]) => outputs.listProducedPorts(nodeRunIds),
    frozenTriggerContext: (taskId: string) => triggers.frozenContext(taskId),
  })
}
