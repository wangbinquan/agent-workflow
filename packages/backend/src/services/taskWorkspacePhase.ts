// RFC-317 T50（findings LC-05）—— 「任务工作区处于哪一阶段」的**唯一** DB 侧读法。
//
// 纯判据住在 `@agent-workflow/shared` 的 `taskWorkspacePhase`（不碰 DB，可被前端复用）。
// 它需要一条 DB 事实：该任务有没有 `__repo_prep__` 的 node_run 行。此前三个调用点里
// 只有 `assertWorktreePresentForResume` 查了这一条，另两处直接省略——于是存量物化失败
// 的任务行在三处得到三种结论（见 shared 侧那段注释）。
//
// 这里给批量场景（autoResume / stuckTaskDetector 一次处理一批候选）提供一次查询，
// 而不是每行一次；单行场景直接传 `[id]`。

import { and, eq, inArray } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { REPO_PREP_NODE_ID } from '@agent-workflow/shared'

/**
 * 这批任务里，哪些已经落下了 `__repo_prep__` 行。
 *
 * 空入参直接返回空集合——`inArray(x, [])` 在 SQLite 上是恒假，但显式短路省掉一次往返，
 * 也让「没有候选」这件事在读代码时是显然的。
 */
export function taskIdsWithRepoPrepRow(
  db: DbClient,
  taskIds: readonly string[],
): ReadonlySet<string> {
  if (taskIds.length === 0) return new Set()
  // `groupBy` + `limit`：一个任务可能有多条 `__repo_prep__` 行（重试各留一行），
  // 而这里只要「有没有」。分组后每个 taskId 至多一行，于是行数被入参长度真实卡死——
  // 不是靠 IN 子句"看起来"有界（RFC-311 的无界读棘轮按 `.limit(` 判，且它判得对：
  // 一个只在子句里有界的查询，下次有人放宽子句时不会有任何东西提醒他）。
  const rows = db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(and(inArray(nodeRuns.taskId, [...taskIds]), eq(nodeRuns.nodeId, REPO_PREP_NODE_ID)))
    .groupBy(nodeRuns.taskId)
    .limit(taskIds.length)
    .all()
  return new Set(rows.map((row) => row.taskId))
}
