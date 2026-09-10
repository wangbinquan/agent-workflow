// RFC-359 W8 —— 「这个任务同步不了」的预览投影：**一份实现，两个 provider 共用**。
//
// 合一前 `sqliteTaskRouteOperations.ts` 与 `postgresqlTaskRouteOperations.ts` 各揣一份逐字相同的
// `notSyncable`。它是纯投影——只把一个拒绝理由包成 `WorkflowSyncPreview` 的否定形态，不碰数据库、
// 不碰任何方言，两份并存的唯一后果就是「改一份、漂另一份」：往这个投影里加字段时漏改一侧，
// 那一侧的前端会拿到少一个字段的对象，而两条路径各自的用例都还绿着。
//
// 落在 `domain/` 而不是 `infrastructure/`：它的入参与返回值全部来自 `@agent-workflow/shared`
// 的执行合同，没有任何持久化面。
import { emptyWorkflowSyncDiff, type Task, type WorkflowSyncPreview } from '@agent-workflow/shared'

/** 一个不可同步的任务的完整预览：理由是唯一变量，其余字段是这个形态的常量。 */
export function notSyncableWorkflowPreview(
  task: Task,
  reason: WorkflowSyncPreview['reason'],
): WorkflowSyncPreview {
  return {
    syncable: false,
    reason,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    currentVersion: task.workflowVersion,
    latestVersion: null,
    differs: false,
    invalid: false,
    invalidIssues: [],
    diff: emptyWorkflowSyncDiff(),
  }
}
