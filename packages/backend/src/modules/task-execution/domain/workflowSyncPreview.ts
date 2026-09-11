// RFC-359 W8 —— 「这个任务同步不了」的预览投影：**一份实现，两个 provider 共用**。
//
// 合一前 `sqliteTaskRouteOperations.ts` 与 `postgresqlTaskRouteOperations.ts` 各揣一份逐字相同的
// `notSyncable`。它是纯投影——只把一个拒绝理由包成 `WorkflowSyncPreview` 的否定形态，不碰数据库、
// 不碰任何方言，两份并存的唯一后果就是「改一份、漂另一份」：往这个投影里加字段时漏改一侧，
// 那一侧的前端会拿到少一个字段的对象，而两条路径各自的用例都还绿着。
//
// 落在 `domain/` 而不是 `infrastructure/`：它的入参与返回值全部来自 `@agent-workflow/shared`
// 的执行合同，没有任何持久化面。
import {
  allowedFromForTaskEvent,
  emptyWorkflowSyncDiff,
  type Task,
  type TaskStatus,
  type WorkflowSyncPreview,
} from '@agent-workflow/shared'

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

/**
 * RFC-104 —— 内置工作流永远不能被手动 sync（`POST sync-workflow` 是 403 `builtin-readonly`），
 * 所以预览必须明说 `builtin-workflow`，前端据此**隐藏**同步横幅（Codex impl-gate F4）。
 *
 * 与 `notSyncableWorkflowPreview` 的差别只有 `latestVersion`：这里是知道工作流行的，最新版本号
 * 照常给出，前端仍能显示「上游已到 vN」。合一前只有 SQLite 一侧有这个分支——PostgreSQL 侧压根
 * 不看 `workflows.builtin`，内置工作流的任务在 PG 上拿到的是 `workflow-deleted`（因为可启动性
 * 授权把内置工作流挡了下来，异常被兜成「工作流没了」），横幅内容直接是错的。
 */
export function builtinWorkflowSyncPreview(task: Task, latestVersion: number): WorkflowSyncPreview {
  return { ...notSyncableWorkflowPreview(task, 'builtin-workflow'), latestVersion }
}

/**
 * 可同步判据：**任务状态**在 `sync-workflow` 的允许集内，且工作树还在。两个 provider 共用。
 *
 * 合一前只有 SQLite 的预览走这条判据；PostgreSQL 的预览改看**进程内**活跃表
 * (`activity.isActive`)，于是一个持久化状态是 `running` 的任务（守护进程刚重启、或任务由别的
 * 进程在跑）在 PG 上预览成 `syncable: true`，而同一个请求真点下去，`syncWorkflow` 用的又是
 * 状态判据，稳定 409 `task-not-syncable`：横幅说能同步、按钮必然失败。
 */
export function workflowSyncGateReason(
  input: Readonly<{ status: TaskStatus; worktreeMissing: boolean }>,
): Extract<WorkflowSyncPreview['reason'], 'ok' | 'worktree-missing' | 'task-active'> {
  if (input.worktreeMissing) return 'worktree-missing'
  return allowedFromForTaskEvent({ kind: 'sync-workflow' }).includes(input.status)
    ? 'ok'
    : 'task-active'
}
