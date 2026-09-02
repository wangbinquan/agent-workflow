// RFC-350 —— 不活跃超时收割的 provider-owned 读写口。
//
// 与 `ResourceLimitPersistence` 同形：数据库客户端只出现在 adapter 里，application
// 只认这几个方法。`cancelTask` / `killRunProcessTree` / `recordReapAudit` 同样由
// bootstrap 注入——本端口**不伪造任何 provider 兜底**（RFC-349 的准入纪律）。

import type { StaleRunKillOutcome } from '@/util/process'
import type { TaskActivityRecord } from '../../domain/idleTimeoutPolicy'

/** 树内一条仍非终态的 node_run 的进程身份快照（收割前要杀的那些）。 */
export interface IdleTimeoutRunSnapshot {
  readonly nodeRunId: string
  readonly taskId: string
  readonly pid: number | null
  /** node_run 自己的 started_at —— `killStaleRunProcessTree` 的 PID 复用窗口判据。 */
  readonly startedAt: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
}

export interface IdleTimeoutTreeSnapshot {
  readonly rootTaskId: string
  /** 整棵树的全部成员（含已终态的），活动时刻按四类数据源合成。 */
  readonly members: readonly TaskActivityRecord[]
  readonly liveRuns: readonly IdleTimeoutRunSnapshot[]
}

export interface TaskIdleTimeoutPersistence {
  /**
   * 未软删且**仍有非终态成员**的任务树根 id，最多 `limit` 个。
   *
   * 排序是「**最老的活任务**优先」，不是「树内活动最早优先」——后者要先把每棵候选树
   * 都载出来算一遍活动时刻，正是这条起手式要避免的开销。它只影响一拍收不完时的取样
   * 顺序（下一拍会接着收），不影响判据。起手式只扫活任务，不碰全表（RFC-311 性能纪律）。
   */
  listIdleCandidateRoots(limit: number): Promise<readonly string[]>
  /** 整棵树的活动快照；树不存在（并发删除）时返回 null。 */
  loadTreeActivity(rootTaskId: string): Promise<IdleTimeoutTreeSnapshot | null>
  /**
   * 覆盖收割原因，并回报**这一行到底是不是被本次收割认领了**。
   *
   * 只更新「取消真的落了」的行（status='canceled' 且 summary 仍是 cancelTask 写的
   * 默认值）——竞态里被别的终态写手抢先的行保留它自己的真实原因，与 `writeLimitReason`
   * 的 RFC-097 audit S-14 教训同款。
   *
   * 返回值不是锦上添花：判定与收割之间有一个窗口，任务可能自己跑完变 `done`
   * （design §8 F-9）。那种情况下覆盖是空操作，而如果照写审计，任务详情页的「恢复」
   * 区就会出现一条「因长时间无活动被自动终结」——对一个刚刚成功完成的任务撒谎。
   * 所以审计只在认领成功时写。
   */
  writeIdleTimeoutReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<boolean>
  /**
   * 收割审计。与 `recordLimitCancellation` 同款由 persistence 自己写（它就是一次
   * 数据库写入），best-effort：审计插不进去不能让收割本身失败。
   */
  recordReapAudit(input: IdleTimeoutAuditRecord): Promise<void>
}

/** 一条收割审计（落 `recovery_events`，任务详情页「恢复」区可见）。 */
export interface IdleTimeoutAuditRecord {
  readonly taskId: string
  readonly reason: string
  readonly silentMs: number
  readonly thresholdMs: number
  readonly killOutcomes: Readonly<Record<string, number>>
  readonly now: number
}

export interface TaskIdleTimeoutOperations {
  readonly persistence: TaskIdleTimeoutPersistence
  /** 由 task-execution composition 注入；application 不知道是哪个 provider。 */
  readonly cancelTask: (taskId: string) => Promise<void>
  /** 注入 `killStaleRunProcessTree`（带 PID 复用窗口 + 二进制身份门）。 */
  readonly killRunProcessTree: (run: IdleTimeoutRunSnapshot) => Promise<StaleRunKillOutcome>
}
