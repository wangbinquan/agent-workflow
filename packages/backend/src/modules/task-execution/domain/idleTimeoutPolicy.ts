// RFC-350 —— 任务不活跃超时（僵尸任务）判据。
//
// 零依赖纯函数：不 import 任何 `@/db`、drizzle、config 或进程状态，两个 provider
// 与全部测试共用同一份判据（RFC-294 G1 —— domain 只依赖中性值对象）。
//
// 判定单位是**整棵任务树**（决策 D5）。树内任一成员有过动作，整棵树都算活着——
// 父任务在 call 节点上等子任务时自身不产生任何事件，逐个任务判会先把它误杀、再由
// cancelTask 的父→子级联把正在干活的子任务一起带走。
//
// 「动作」的口径（决策 D2/D6）由 persistence 合成进 `TaskActivityRecord.activityAt`，
// 取四类数据源的 max：任务 started_at/finished_at、node_runs.started_at、
// node_run_events.ts、collaboration_gate_operations 里 operation_kind='decide' 且
// 已 committed 的行。**刻意不含**评论、协作者变更、反问逐题草稿与任务反馈：一条
// 评论就能无限续命一个没人推进的任务，而那正是本功能要治的形态。

import { CANCELABLE_TASK_STATUSES, type TaskStatus } from '@agent-workflow/shared'

/** 一棵树里某个成员的活动快照。`activityAt` 由 persistence 按上面四类数据源合成。 */
export interface TaskActivityRecord {
  readonly taskId: string
  readonly status: TaskStatus
  readonly activityAt: number
}

export interface IdleTreeVerdict {
  readonly rootTaskId: string
  /** 三条判据同时成立才为 true，见 `judgeIdleTree`。 */
  readonly idle: boolean
  /** 树内成员 `activityAt` 的最大值（空树为 0）。 */
  readonly treeActivityAt: number
  /** `now - treeActivityAt`，负值归零（时钟回拨）。 */
  readonly silentMs: number
  /**
   * 树内**可取消**的成员，也就是本次要被收割的那些。
   *
   * `interrupted` 不在其中：它在 `TERMINAL_TASK_STATUSES` 里已是终态，且 `cancel`
   * 事件的 allowed-from 不含它（`shared/lifecycle.ts`），强行 cancel 只会抛
   * IllegalTaskTransition。它的出路是 RFC-350 另一半——归档器认它为终态后按保留期出库。
   */
  readonly liveTaskIds: readonly string[]
}

const CANCELABLE = new Set<string>(CANCELABLE_TASK_STATUSES)

/** 该状态的任务能不能被本收割器终结。 */
export function isReapableStatus(status: string): boolean {
  return CANCELABLE.has(status)
}

/** 小时阈值 → 毫秒。配置面用小时（决策 D7），判据内部一律用毫秒。 */
export function idleTimeoutThresholdMs(idleHours: number): number {
  return Math.trunc(idleHours) * 3_600_000
}

/**
 * 僵尸判据。三条**同时**成立才收：
 *
 *   1. 树内至少有一个可取消（非终态）成员——全终态的树不归本功能管，它是既有
 *      `taskArchive` 保留期的活儿；
 *   2. 树的活动时刻 = 全体成员 `activityAt` 的 max；
 *   3. 静默时长**严格大于**阈值。
 *
 * 边界上取严格大于而不是 >=：阈值本身那一刻还不算超时，少一次「刚好卡在整点被收」
 * 的意外。
 */
export function judgeIdleTree(input: {
  readonly rootTaskId: string
  readonly members: readonly TaskActivityRecord[]
  readonly now: number
  readonly thresholdMs: number
}): IdleTreeVerdict {
  const liveTaskIds = input.members
    .filter((member) => isReapableStatus(member.status))
    .map((member) => member.taskId)
  let treeActivityAt = 0
  for (const member of input.members) {
    if (member.activityAt > treeActivityAt) treeActivityAt = member.activityAt
  }
  const silentMs = Math.max(0, input.now - treeActivityAt)
  // 空树 / 全终态树 / 阈值非正 一律不收。阈值非正在配置层已被 min:1 挡住，这里
  // 再兜一次，避免任何调用方传 0 就把全库活任务扫平。
  const idle =
    liveTaskIds.length > 0 &&
    input.members.length > 0 &&
    input.thresholdMs > 0 &&
    silentMs > input.thresholdMs
  return Object.freeze({
    rootTaskId: input.rootTaskId,
    idle,
    treeActivityAt,
    silentMs,
    liveTaskIds: Object.freeze(liveTaskIds),
  })
}

/** 被收割任务写进 `error_summary` 的机器 token（前端按它取中文文案）。 */
export const IDLE_TIMEOUT_SUMMARY = 'task-idle-timeout'

/**
 * 覆盖进任务行的原因文案。与 `services/limits.ts` 的资源上限先例同款：cancelTask
 * 写的是通用的 'canceled by user'，随后由收割方覆盖成本次真正的原因，否则用户在详情页
 * 只能看到「被人取消了」。
 */
export function idleTimeoutReason(input: {
  readonly silentMs: number
  readonly thresholdMs: number
}): { readonly summary: string; readonly message: string } {
  return {
    summary: IDLE_TIMEOUT_SUMMARY,
    message:
      `task had no activity for ${input.silentMs}ms, ` +
      `exceeding the configured idle timeout ${input.thresholdMs}ms`,
  }
}
