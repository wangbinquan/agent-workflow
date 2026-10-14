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
  // 同一次接手一起翻的另两格：running 段起点与生命周期事件修订号。只摘 status 时它们照样
  // 随接手早晚不等（CI 38608703903 shard 8：一条 lane lifecycleEventRevision 2 / runningSince
  // 有值，另一条 1 / null）。三格的自洽改由 earlyLifecycleViolation 逐 lane 守。
  'runningSince',
  'lifecycleEventRevision',
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

/**
 * 摘掉的三格仍要自洽（RFC-207：进入 running 记下段起点，离开 running 清空并累计
 * runningMs；每次生命周期转移修订号 +1）：running ⇔ 有段起点；还在 pending 说明一次转移都
 * 没发生过，修订号是初值 1；其余状态都已转移过，修订号必然前进。返回违例说明，自洽时为 null。
 */
export function earlyLifecycleViolation(row: Record<string, unknown>): string | null {
  const status = String(row['status'])
  const runningSince = row['runningSince']
  const revision = Number(row['lifecycleEventRevision'])
  const started = runningSince !== null && Number.isFinite(Number(runningSince))
  const facts = `status=${status} runningSince=${String(runningSince)} revision=${revision}`
  if ((status === 'running') !== started) return `只有 running 段才有起点：${facts}`
  if (status === 'pending') {
    return revision === 1 ? null : `pending 尚未发生转移，修订号应为 1：${facts}`
  }
  return revision > 1 ? null : `离开 pending 必有转移，修订号应已前进：${facts}`
}
