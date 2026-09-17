// RFC-359 AC-1（plan §5hn 批次二 ④）—— 「两个引擎落出同一行」的**行级**可比投影。
//
// 为什么单独抽出来：§5hn 的几条启动等价性基线一开始都只比 **HTTP 响应体**，而响应体是
// `taskProjection(...)` 现算的投影，不是库里那行的回读。变异实证（2026-09-17）：把根启动内核
// INSERT 里的 `name` 改成 `${name}_MUTANT`，**只比响应体的判据照过**——因为响应那一格来自入参。
// 标题写着「落库对等」，就得真去读库。
//
// 这里只做「摘掉逐次必然不同的那几格」，其余整行都比——与响应体那半同一条口径
//（拒绝清单，不是允许清单：允许清单只能保护想得到的字段）。
export const VOLATILE_TASK_ROW_COLUMNS: readonly string[] = [
  // 身份与时间戳
  'id',
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'expiresAt',
  'deletedAt',
  'branchStartedAt',
  // 本次工作区
  'branch',
  'repoPath',
  'worktreePath',
  'baseCommit',
  // 本次引用的资源（两个 lane 各自新建，id 天然不同）
  'workflowId',
  'workflowName',
  'workflowSnapshot',
  // 本次血缘
  'rootTaskId',
  'executionLineageId',
  'lineageSlotPathJson',
  // 调度器异步接手：读回来时可能已经从 pending 翻到 running（时间相关，不是引擎差异）
  'status',
]

/**
 * @param extraVolatile 各用例自己的那几格（例如按 lane 新建的 agent / workgroup id、
 *   定时行 id、带墙钟装饰的任务名）。
 */
export function comparableTaskRow(
  row: Record<string, unknown>,
  extraVolatile: readonly string[] = [],
): Record<string, unknown> {
  const denied = new Set([...VOLATILE_TASK_ROW_COLUMNS, ...extraVolatile])
  const comparable: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) {
    if (denied.has(key)) continue
    comparable[key] = row[key]
  }
  return comparable
}
