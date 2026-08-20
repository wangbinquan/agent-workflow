// RFC-284 T22（2026-08-12 审计 N26）——daemon 后台节奏唯一注册表。
//
// 此前「某状态最坏多久被扫到」要翻 9 个文件（各扫描器 opts 默认值 + start.ts
// 两处连常量名都没有的裸 1h）。本表只收**周期/节奏**（多久跑一次）；阈值类
// （stuck 30min、pending 5min 等「多久算异常」）语义不同，留在各 owner 模块
// 并在此以注释索引。数值全部与收口前逐字相等——本表是可读性收口，不是调参。

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * 60 * 1000

export const DAEMON_CADENCE = {
  /** autoKill 扫描（services/autoKill.ts；DEFAULT OFF 的自动闭环之一）。 */
  autoKill: 5 * MINUTE_MS,
  /** autoRepair 扫描（services/autoRepair.ts）。 */
  autoRepair: 5 * MINUTE_MS,
  /** stuck-task 检测（services/stuckTaskDetector.ts；阈值 S1-S5 见该模块）。 */
  stuckTaskScan: 5 * MINUTE_MS,
  /** 孤儿进程周期回收（services/orphanReconcile.ts；可由 opts 覆盖）。 */
  orphanReconcile: 10 * MINUTE_MS,
  /** 生命周期不变量扫描（services/lifecycleInvariants.ts）。 */
  lifecycleInvariants: HOUR_MS,
  /** worktree/iso GC ticker（services/gc.ts）。 */
  worktreeGc: HOUR_MS,
  /** fusion 对账（services/fusion.ts）。 */
  fusionReconcile: MINUTE_MS,
  /** 资源上限检查 1Hz（services/limits.ts）。 */
  resourceLimits: 1_000,
  /** intent 协议失败 scratch 保留 GC（cli/start.ts；RFC-273）。 */
  intentScratchGc: HOUR_MS,
  /** token 审计日志 GC（cli/start.ts）。 */
  tokenAuditGc: HOUR_MS,
  /** RFC-310 mission wake sweep（到期 durable wake + 未消费 wake hint）。 */
  developmentWakeSweep: 30_000,
  /** RFC-310 未 claim mission 上传的 TTL 回收。 */
  developmentUploadGc: HOUR_MS,
  /** RFC-310 T71 —— 终态 Mission 的 retention 执行（台账清理 + 证据过期标记）。 */
  developmentRetentionSweep: HOUR_MS,
  /** RFC-310 Digital Employee OS durable Event → Reaction driver. */
  digitalEmployeeOs: 1_000,
} as const satisfies Record<string, number>
