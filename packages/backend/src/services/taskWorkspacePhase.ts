// RFC-317 T50（findings LC-05）—— 「任务工作区处于哪一阶段」的**唯一** DB 侧读法。
//
// 纯判据住在 `@agent-workflow/shared` 的 `taskWorkspacePhase`（不碰 DB，可被前端复用）。
// 它需要一条 DB 事实：该任务有没有 `__repo_prep__` 的 node_run 行。此前三个调用点里
// 只有 `assertWorktreePresentForResume` 查了这一条，另两处直接省略——于是存量物化失败
// 的任务行在三处得到三种结论（见 shared 侧那段注释）。
//
// 这里给批量场景（autoResume / stuckTaskDetector 一次处理一批候选）提供一次查询，
// 而不是每行一次；单行场景直接传 `[id]`。

import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'

/**
 * 这批任务里，哪些已经落下了 `__repo_prep__` 行。
 *
 * 空入参直接返回空集合——`inArray(x, [])` 在 SQLite 上是恒假，但显式短路省掉一次往返，
 * 也让「没有候选」这件事在读代码时是显然的。
 */
export async function taskIdsWithRepoPrepRow(
  operations: TaskRecoveryOperations,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  return operations.taskIdsWithRepoPrepRow(taskIds)
}
