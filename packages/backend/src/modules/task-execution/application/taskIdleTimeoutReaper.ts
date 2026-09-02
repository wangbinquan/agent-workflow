// RFC-350 —— 不活跃超时收割器（僵尸任务），**默认关闭**。
//
// 一拍的形状：
//
//   listIdleCandidateRoots → loadTreeActivity → judgeIdleTree（纯函数）
//     → 杀进程树 → cancelTask（自带父→子级联）→ 覆盖原因文案 → 写恢复审计
//
// 为什么先杀后取消：`cancelTask` 只在还有活 scheduler controller 时才能 abort 子进程，
// 而僵尸的典型形态恰恰是 controller 没了 / 卡死了。先杀再改状态，避免留下「库里
// canceled、机器上还在写 worktree」的窗口。
//
// 杀不掉不阻断终结（决策 D11）：`killStaleRunProcessTree` 的 48h PID 复用窗口意味着
// 阈值一旦配到 ≥24 小时，`window-expired` 会是**常见**结果而不是异常——一个跑了三天、
// 最后 25 小时没动静的 run，其 started_at 早就超出窗口，helper 会拒绝发信号。那是
// 既有安全网的正确行为（不能为本功能放宽，否则可能 SIGKILL 一个被复用的无关 pid），
// 本收割器的责任是如实记录 outcome 并让任务照常终结。
//
// 收割 ≠ 出库：本模块只负责判终态，出库仍由既有 `taskArchive` 按 retentionDays 完成。
// 两道开关各管一段（决策 D1/D10）。

import { createLogger } from '@/util/log'

import {
  idleTimeoutReason,
  idleTimeoutThresholdMs,
  judgeIdleTree,
  type IdleTreeVerdict,
} from '../domain/idleTimeoutPolicy'
import type {
  IdleTimeoutTreeSnapshot,
  TaskIdleTimeoutOperations,
} from './ports/taskIdleTimeoutPersistence'

const log = createLogger('task-idle-timeout')

/**
 * 单拍最多收几棵树。刻意**不做成用户旋钮**：配置面已按决策 D8 压到 enabled +
 * idleHours 两项，而这是一个「别把一拍撑爆」的实现细节，不是产品语义。
 */
export const MAX_TREES_PER_SWEEP = 20

export interface TaskIdleTimeoutConfig {
  readonly enabled: boolean
  readonly idleHours: number
}

export interface IdleTimeoutSweepResult {
  /** 本拍看了几棵候选树。 */
  readonly scanned: number
  readonly reapedTrees: number
  readonly reapedTasks: number
  /** 抛错被跳过的树（不阻塞其它树）。 */
  readonly skipped: number
}

const EMPTY_RESULT: IdleTimeoutSweepResult = Object.freeze({
  scanned: 0,
  reapedTrees: 0,
  reapedTasks: 0,
  skipped: 0,
})

export interface IdleTimeoutSweepOptions {
  readonly now?: number
  readonly maxTrees?: number
}

export async function runTaskIdleTimeoutSweep(
  operations: TaskIdleTimeoutOperations,
  config: TaskIdleTimeoutConfig,
  options: IdleTimeoutSweepOptions = {},
): Promise<IdleTimeoutSweepResult> {
  const thresholdMs = idleTimeoutThresholdMs(config.idleHours)
  // 关着时一次 IO 都不发（AC-1）。阈值非正同理——配置层的 min:1 已经挡住，这里兜底。
  if (!config.enabled || thresholdMs <= 0) return EMPTY_RESULT

  const now = options.now ?? Date.now()
  const maxTrees = options.maxTrees ?? MAX_TREES_PER_SWEEP
  const roots = await operations.persistence.listIdleCandidateRoots(maxTrees)

  let reapedTrees = 0
  let reapedTasks = 0
  let skipped = 0
  for (const rootTaskId of roots) {
    try {
      const snapshot = await operations.persistence.loadTreeActivity(rootTaskId)
      // 并发删除 / 整棵树在扫描后落终态 ⇒ 本拍无事可做。
      if (snapshot === null) continue
      const verdict = judgeIdleTree({
        rootTaskId,
        members: snapshot.members,
        now,
        thresholdMs,
      })
      if (!verdict.idle) continue
      reapedTasks += await reapTree(operations, snapshot, verdict, thresholdMs, now)
      reapedTrees += 1
    } catch (err) {
      // 一棵树失败不拖累其它树（与归档器 runTaskArchiveSweep 的隔离同款）。
      skipped += 1
      log.warn('idle-timeout reap failed; tree left intact', {
        rootTaskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 一棵都没收就什么也不写：默认开启后每 5 分钟一行空日志会把日志刷成噪音（AC-8）。
  if (reapedTrees > 0 || skipped > 0) {
    log.warn('idle tasks reaped', {
      scanned: roots.length,
      reapedTrees,
      reapedTasks,
      skipped,
      thresholdMs,
    })
  }
  return Object.freeze({ scanned: roots.length, reapedTrees, reapedTasks, skipped })
}

/** 收割一棵已判定的僵尸树，返回被收的任务数。 */
async function reapTree(
  operations: TaskIdleTimeoutOperations,
  snapshot: IdleTimeoutTreeSnapshot,
  verdict: IdleTreeVerdict,
  thresholdMs: number,
  now: number,
): Promise<number> {
  const live = new Set(verdict.liveTaskIds)
  const killOutcomes: Record<string, number> = {}
  for (const run of snapshot.liveRuns) {
    // 树里可能混着已终态成员的历史 run；只对要收割的任务动手。
    if (!live.has(run.taskId)) continue
    let outcome: string
    try {
      outcome = await operations.killRunProcessTree(run)
    } catch (err) {
      outcome = 'kill-failed'
      log.warn('idle-timeout kill threw', {
        nodeRunId: run.nodeRunId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    killOutcomes[outcome] = (killOutcomes[outcome] ?? 0) + 1
  }

  // 根先取消：cancelTask 自带父→子级联，一次就能带走整棵子树；剩下的逐个补，
  // 已被级联带走的行会以 ConflictError 收场，吞掉即可。
  const ordered = [
    ...verdict.liveTaskIds.filter((id) => id === snapshot.rootTaskId),
    ...verdict.liveTaskIds.filter((id) => id !== snapshot.rootTaskId),
  ]
  const reason = idleTimeoutReason({ silentMs: verdict.silentMs, thresholdMs })
  let reaped = 0
  for (const taskId of ordered) {
    try {
      await operations.cancelTask(taskId)
    } catch (err) {
      // 已终态（自身级联 / 竞态里别的写手先到）不是错误：原因文案的写入门会再判一次
      // 「这行到底是不是我们取消的」，不会覆盖别人的真实原因。
      log.debug('idle-timeout cancel skipped', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const claimed = await operations.persistence.writeIdleTimeoutReason({
      taskId,
      summary: reason.summary,
      message: reason.message,
    })
    // 判定与收割之间的窗口里任务可能自己跑完（design §8 F-9）。没认领到就什么也不记：
    // 给一个刚刚成功完成的任务留一条「因长时间无活动被自动终结」的恢复记录是撒谎。
    if (!claimed) {
      log.debug('idle-timeout reap lost the race; task settled on its own', { taskId })
      continue
    }
    reaped += 1
    await operations.persistence.recordReapAudit({
      taskId,
      reason: reason.message,
      silentMs: verdict.silentMs,
      thresholdMs,
      killOutcomes: Object.freeze({ ...killOutcomes }),
      now,
    })
  }
  return reaped
}
