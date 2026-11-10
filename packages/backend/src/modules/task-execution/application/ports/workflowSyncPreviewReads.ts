import type { NodeRunFactSnapshot } from './nodeRunQueries'

/**
 * RFC-478 —— 工作流同步预览（`application/workflowSyncPreviewQuery.ts`）要的四个读，task-execution 自有端口。
 * 实现：`infrastructure/workflowSyncPreviewReads.ts`，与原 `services/task.ts` 函数体里的四处查询一一对应。
 */
export interface WorkflowSyncPreviewReads {
  /** 任务的全部可执行节点运行行。 */
  listNodeRuns(taskId: string): Promise<readonly NodeRunFactSnapshot[]>
  /** 该节点最新一条 done 的顶层行（RFC-374 seq 序）；没有则 null。 */
  freshestDoneTopLevelRunId(taskId: string, nodeId: string): Promise<string | null>
  /** 这些行产出的输出端口。 */
  producedPorts(
    nodeRunIds: readonly string[],
  ): Promise<readonly { readonly nodeRunId: string; readonly portName: string }[]>
  /** 任务冻结的触发上下文 JSON。 */
  frozenTriggerContext(taskId: string): Promise<string | null | undefined>
}
