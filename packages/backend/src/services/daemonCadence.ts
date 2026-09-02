// RFC-284 T22（2026-08-12 审计 N26）——daemon 后台节奏注册表。
//
// 此前「某状态最坏多久被扫到」要翻 9 个文件（各扫描器 opts 默认值 + start.ts
// 两处连常量名都没有的裸 1h）。本表只收**周期/节奏**（多久跑一次）；阈值类
// （stuck 30min、pending 5min 等「多久算异常」）语义不同，留在各 owner 模块
// 并在此以注释索引。数值全部与收口前逐字相等——本表是可读性收口，不是调参。
//
// ⚠️ **不是全仓唯一**（RFC-317 T66 按源码订正；原文写的是「唯一注册表」）。
// 本表被 10 个文件消费，而 `packages/backend/src` 下有 35 处 `setInterval(`；
// 至少这几处仍各自带默认周期，没有进表：
//   · services/backupScheduler.ts:194 —— `setInterval(…, 3_600_000)` 裸字面量，
//     正是本表被创造出来消灭的那种形状；
//   · services/taskArchive.ts / maintenanceRetention.ts / eventsArchive.ts ——
//     `intervalMs: number = 3_600_000` 形式的参数默认值；
//   · services/pluginGenerationGc.ts / memoryDistillScheduler.ts ——
//     模块私有 DEFAULT_INTERVAL_MS / `?? 1000`。
// 并且**没有任何守卫**要求新的周期性循环进表：漏掉一个不会红。
// 「唯一注册表」这句话的危害不在于数错，而在于它让读者停止去别处找——
// 想知道「这个状态最坏多久被扫到」的人读完这句会以为翻完本表就够了。
// RFC-322 收编了上面这些外挂周期，并补上了那条缺失的棘轮：hourly 维护循环一律走
// `services/maintenanceTicker.ts` 的 `startMaintenanceTicker` 并在下面的
// `MAINTENANCE_PHASE` 登记相位，漏登记会被 `tests/rfc322-maintenance-cadence.test.ts`
// 拦下。本段保留是因为它记录的危害（读者读完会以为翻完本表就够了）依然成立：
// 本表仍只收**周期**，非 hourly 的循环（1Hz / 30s / 5min 等）不进 MAINTENANCE_PHASE。

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * 60 * 1000

export const DAEMON_CADENCE = {
  /** autoKill 扫描（services/autoKill.ts；DEFAULT OFF 的自动闭环之一）。 */
  autoKill: 5 * MINUTE_MS,
  /** autoRepair 扫描（services/autoRepair.ts）。 */
  autoRepair: 5 * MINUTE_MS,
  /** stuck-task 检测（services/stuckTaskDetector.ts；阈值 S1-S5 见该模块）。 */
  stuckTaskScan: 5 * MINUTE_MS,
  /**
   * RFC-350 不活跃超时收割（modules/task-execution/application/taskIdleTimeoutReaper.ts；
   * DEFAULT OFF）。阈值最细 1 小时，5 分钟一拍把判定延迟压在阈值的 8% 以内，而扫描面
   * 只有活任务，成本远低于 1Hz 的 resourceLimits。**非 hourly 循环不进
   * MAINTENANCE_PHASE**（那张表只收周期性重维护，见文件头）。
   */
  taskIdleTimeout: 5 * MINUTE_MS,
  /**
   * 孤儿进程周期回收（services/orphanReconcile.ts）的**默认**周期：真正的周期是
   * `periodicOrphanReconcileMs` 这个旋钮（0 = 关），本值只是它的出厂默认，两者由
   * `tests/rfc349-orphan-reconcile-hot-apply.test.ts` 钉在一起。
   */
  orphanReconcile: 10 * MINUTE_MS,
  /**
   * 上面那条的**监督拍**：循环实际睡多久、多久看一眼旋钮。循环按本拍醒来、在醒来
   * 时才判断这一拍要不要真扫（modules/task-execution/composition/providerBackground.ts `isPeriodicReconcileDue`），
   * 于是旋钮改动最迟一分钟生效——关→开、以及把节奏改小，都不必重启 daemon。
   * 取值等于该旋钮允许的最小正周期（settingsNumericBounds.ts `positiveMin: 60_000`），
   * 所以监督拍永远不会比用户配得出来的最细节奏更粗。
   */
  orphanReconcileSupervisory: MINUTE_MS,
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

/**
 * RFC-311 余项 —— 体积封顶类维护循环（事件归档器 / 终态任务 sweeper）**boot 首拍**
 * 的统一延迟。它不是周期，所以不进上表。
 *
 * 为什么需要首拍：只有 `setInterval(1h)` 的循环，在平均重启间隔短于一个周期的部署
 * 上一次都不会执行——生产实测（2026-08-21）跑着含字节水位的 v0.18.11，事件表照样
 * 长到 78.6 万行 / 1.72GB。为什么要延迟：一轮归档在 2.6GB 库上实测 4-6s，没必要撞
 * 在迁移 / 备份 / 恢复 / boot 巡检的开机风暴上（同款形状见
 * `lifecycleInvariants.ts` 的 `bootDelayMs`，那边是纯扫描所以只等 5s）。
 */
export const MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS = 30_000

/**
 * RFC-322 —— 同周期维护任务的**相位偏移**。
 *
 * 为什么需要它：上表只回答「多久跑一次」，没有任何人回答「什么时候跑」。14 个 hourly
 * 循环全部在 boot 的同一秒内装配（`cli/start.ts:885–1376`），于是每小时的同一秒首尾
 * 相接地执行；而 daemon 只有一条 bun:sqlite **同步**连接（`db/client.ts` 自述：一条慢
 * 语句冻结全部 HTTP/WS）。两者叠加就是生产实测的「整点全站冻结约 30 秒、随后恢复」——
 * 现场留下的 `[db-slow] 32648ms` 是一条同库实测仅 10ms、走索引、表仅 346 行的 SELECT，
 * 它不是慢，只是恰好在停顿窗口里被计时（判别办法见 `db/client.ts` 的 cpu 字段）。
 *
 * 为什么是确定性表而不是随机抖动：① 可测——注入定时器即可断言任意两拍不重合；
 * ② 可读——运维看日志就知道 GC 在第 4 分钟、归档在第 12 分钟；③ 与本文件既有风格
 * 一致（`DAEMON_CADENCE` 就是显式表）；④ 本产品单机单实例，不存在需要随机化去打散
 * 的「数千台机器同刻打同一后端」场景。
 *
 * 不变量（`tests/rfc322-maintenance-cadence.test.ts` 锁定）：
 *   ① `0 < offset < 对应 intervalMs`；② 两两互异；③ 相邻间隔 ≥ `MIN_PHASE_GAP_MS`。
 * 新增 hourly 维护循环必须在此登记，否则守卫转红。加到第 15 个时需要重新排布间距，
 * 这是有意的——让「又多一个整点任务」成为一次显式决策，而不是悄悄挤进同一秒。
 */
export const MAINTENANCE_PHASE = {
  /** services/gc.ts —— 单拍串跑 6 段遍历文件系统的 GC，是最重的一拍，排第一。 */
  worktreeGc: 4 * MINUTE_MS,
  /** services/webhook/webhookGc.ts */
  webhookDeliveryGc: 8 * MINUTE_MS,
  /** services/eventsArchive.ts —— 2.6GB 库上一轮实测 4-6s。 */
  eventsArchive: 12 * MINUTE_MS,
  /** services/maintenanceRetention.ts */
  retentionSweep: 16 * MINUTE_MS,
  /** services/taskArchive.ts */
  taskArchive: 20 * MINUTE_MS,
  /** services/backupScheduler.ts —— 备份保留期 prune（与备份拍本身无关）。 */
  backupPrune: 24 * MINUTE_MS,
  /** services/repoBatchImport.ts */
  batchImportGc: 28 * MINUTE_MS,
  /** services/pluginGenerationGc.ts */
  pluginGenerationGc: 32 * MINUTE_MS,
  /** cli/start.ts —— RFC-310 未 claim 上传的 TTL 回收。 */
  developmentUploadGc: 36 * MINUTE_MS,
  /** cli/start.ts —— RFC-310 T71 终态 Mission 的 retention 执行。 */
  developmentRetentionSweep: 40 * MINUTE_MS,
  /** cli/start.ts —— 数字员工输入 GC（与 developmentUploadGc 同周期、不同相位）。 */
  employeeInputGc: 44 * MINUTE_MS,
  /** cli/start.ts —— RFC-273 intent 协议失败 scratch 保留 GC。 */
  intentScratchGc: 48 * MINUTE_MS,
  /** cli/start.ts —— RFC-247 D16 token 审计日志 GC。 */
  tokenAuditGc: 52 * MINUTE_MS,
  /** services/lifecycleInvariants.ts —— 纯扫描，排最后。 */
  lifecycleInvariants: 56 * MINUTE_MS,
} as const satisfies Record<string, number>

export type MaintenanceJob = keyof typeof MAINTENANCE_PHASE

/** 相邻相位的最小间距。它不是「一拍最多跑多久」的保证，只是让重叠面从 14 降到 2。 */
export const MIN_PHASE_GAP_MS = 3 * MINUTE_MS

/**
 * 一拍耗时超过它就 warn 一行（带任务名与耗时）。
 *
 * 取 1 秒的理由：低于 1 秒的一拍不值得占日志；高于 1 秒意味着事件循环被这个维护任务
 * 冻结了 1 秒以上，在单同步连接的 daemon 上等于全站停摆 1 秒，属于必须能看见的事。
 */
export const MAINTENANCE_SLOW_TICK_MS = 1_000
