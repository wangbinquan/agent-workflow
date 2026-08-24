# RFC-322 维护节奏错峰与停顿归因 —— design

## 1. 现状盘点（源码实测，2026-08-24）

`cli/start.ts` 在 boot 的同一秒内装配了 **14 个 hourly 维护定时器**，全部零相位、零抖动：

| #   | 任务                   | 装配点                      | 实现                                   | 周期来源                                   | 现有 boot 首拍 |
| --- | ---------------------- | --------------------------- | -------------------------------------- | ------------------------------------------ | -------------- |
| 1   | worktree GC 链（6 段） | `cli/start.ts:885`          | `services/gc.ts:802`                   | `DAEMON_CADENCE.worktreeGc`                | 无             |
| 2   | webhook delivery GC    | `cli/start.ts:894`          | `services/webhook/webhookGc.ts:48`     | 模块私有                                   | 无             |
| 3   | events 归档            | `cli/start.ts:895`          | `services/eventsArchive.ts:437`        | `HOUR_MS`                                  | 30s            |
| 4   | 保留期 sweeper         | `cli/start.ts:898`          | `services/maintenanceRetention.ts:182` | 裸 `3_600_000`                             | 无             |
| 5   | 终态任务归档           | `cli/start.ts:911`          | `services/taskArchive.ts:600`          | 裸 `3_600_000`                             | 30s            |
| 6   | backup 保留期 prune    | `cli/start.ts:920`          | `services/backupScheduler.ts:194`      | 裸 `3_600_000`                             | boot 即跑      |
| 7   | 仓库批量导入 GC        | `cli/start.ts:959`          | `services/repoBatchImport.ts:337`      | `HOUR_MS`                                  | 无             |
| 8   | plugin 生成物 GC       | `cli/start.ts:963`          | `services/pluginGenerationGc.ts:59`    | 模块私有                                   | boot 即跑      |
| 9   | development upload GC  | `cli/start.ts:1142`（内联） | 同处                                   | `DAEMON_CADENCE.developmentUploadGc`       | 无             |
| 10  | development retention  | `cli/start.ts:1156`（内联） | 同处                                   | `DAEMON_CADENCE.developmentRetentionSweep` | 无             |
| 11  | employee input GC      | `cli/start.ts:1301`（内联） | 同处                                   | `DAEMON_CADENCE.developmentUploadGc`       | 无             |
| 12  | intent scratch GC      | `cli/start.ts:1313`（内联） | 同处                                   | `DAEMON_CADENCE.intentScratchGc`           | 无             |
| 13  | token 审计 GC          | `cli/start.ts:1337`（内联） | 同处                                   | `DAEMON_CADENCE.tokenAuditGc`              | 无             |
| 14  | 生命周期不变量扫描     | `cli/start.ts:1376`         | `services/lifecycleInvariants.ts:931`  | `DAEMON_CADENCE.lifecycleInvariants`       | 5s             |

除 #1/#14 外，其余全部是同一套模板：

```ts
let running = false
const tick = (): void => {
  if (running) return
  running = true
  work().catch(err => log.warn('…', { error: … })).finally(() => { running = false })
}
const handle = setInterval(tick, intervalMs)
;(handle as { unref?: () => void }).unref?.()
return { stop: () => clearInterval(handle) }
```

即：**重入守卫 + 吞错 + unref + stop** 这四件事被复制了 14 份，而「什么时候跑」这一件
无人负责。本 RFC 把后者收成一个原语，顺带把前四件从各 ticker 里抽出来。

## 2. 设计

### 2.1 相位注册表（`services/daemonCadence.ts`）

`daemonCadence.ts` 已经是「周期」的注册表，相位是它自然的第二列：

```ts
/** 同周期维护任务的相位偏移。约束（由 rfc322 守卫测试锁定）：
 *  ① 0 < offset < 对应 intervalMs；② 两两互异；③ 相邻间隔 ≥ 3 分钟。
 *  新增 hourly 维护循环必须在此登记，否则守卫转红。 */
export const MAINTENANCE_PHASE = {
  worktreeGc: 4 * MINUTE_MS,
  webhookDeliveryGc: 8 * MINUTE_MS,
  eventsArchive: 12 * MINUTE_MS,
  retentionSweep: 16 * MINUTE_MS,
  taskArchive: 20 * MINUTE_MS,
  backupPrune: 24 * MINUTE_MS,
  batchImportGc: 28 * MINUTE_MS,
  pluginGenerationGc: 32 * MINUTE_MS,
  developmentUploadGc: 36 * MINUTE_MS,
  developmentRetentionSweep: 40 * MINUTE_MS,
  employeeInputGc: 44 * MINUTE_MS,
  intentScratchGc: 48 * MINUTE_MS,
  tokenAuditGc: 52 * MINUTE_MS,
  lifecycleInvariants: 56 * MINUTE_MS,
} as const satisfies Record<string, number>
```

**为什么是确定性相位而不是随机抖动**：① 可测——注入定时器即可断言任意两拍不重合，
随机化只能做统计断言；② 可读——运维看日志就知道 GC 在第 4 分钟、归档在第 12 分钟；
③ 与本仓既有风格一致（`DAEMON_CADENCE` 就是显式表，不是推导值）；④ 本产品是单机
单实例，不存在「同一时刻数千台机器打同一个后端」这种需要随机化的场景。

### 2.2 共享原语（`services/maintenanceTicker.ts`，新增）

```ts
export interface MaintenanceTickerOptions {
  /** 日志/度量用的任务名，与 MAINTENANCE_PHASE 的键一致。 */
  job: string
  intervalMs: number
  /** 周期拍的相位偏移；首个周期拍落在 T0 + phaseOffsetMs。 */
  phaseOffsetMs: number
  /** 可选 boot 首拍，语义与相位正交（保留各 ticker 现状）。 */
  bootDelayMs?: number
  /** 一拍的工作。原语负责重入守卫、计时、吞错。 */
  onTick: () => Promise<void>
  /** 超过它就 warn 一行；默认 MAINTENANCE_SLOW_TICK_MS。 */
  slowTickMs?: number
  /** 测试注入。 */
  timers?: TimerApi
  now?: () => number
}

export function startMaintenanceTicker(o: MaintenanceTickerOptions): { stop: () => void }
```

语义：

- **周期拍**：`setTimeout(phaseOffsetMs)` → 第一拍 → 其后 `setInterval(intervalMs)`。
  故首个周期拍在 `T0 + phaseOffsetMs`（比现状的 `T0 + 1h` **更早**，不会更晚）。
- **boot 拍**：`bootDelayMs` 给了才装，语义与现状逐字相同（30s / 5s / 立即）。
- **重入守卫**：boot 拍与周期拍共用同一个 `running`，与现状一致。
- **吞错**：`onTick` 的 reject 由原语 catch；各 ticker 把自己原有的日志文案放进
  `onTick` 内部的 catch，**日志契约零变化**（AC-6）。
- **计时**：`now()` 包住 `onTick()` 的整个 promise；超阈 warn
  `log.warn('maintenance tick slow', { job, durationMs, intervalMs })`。
- 所有 timer `.unref?.()`；`stop()` 清 boot timer + 相位 timer + interval。

`MAINTENANCE_SLOW_TICK_MS` 默认 **1000**：低于它的一拍不值得占日志，高于它就意味着
事件循环被冻结了 1 秒以上，属于要看的事。

### 2.3 停顿判别（`db/client.ts`）

`instrumentSlowStatements` 现在只量墙钟，于是进程被饿死时会把整段停顿栽给一条无辜
SQL——本次定位就被它误导。加一个几乎零成本的判别量：

```ts
const t0 = performance.now()
const c0 = cpuMicros() // 实测 0.40µs/次
try {
  return fn(...args)
} finally {
  const ms = performance.now() - t0
  if (ms >= thresholdMs) {
    // 第二次只在超阈时才付
    const c1 = c0 === null ? null : cpuMicros()
    const cpuMs = c0 === null || c1 === null ? -1 : Math.round((c1 - c0) / 1000)
    logSlow(Math.round(ms), clip(sql), cpuMs)
  }
}
```

`cpuMs` 放在**尾参**而不是中间：`logSlow` 的既有 2 参回调（`tests/rfc311-perf-foundation.test.ts`
有 4 处）因此逐字不受影响，AC-6 不用靠改别人的测试来满足。`process.cpuUsage()` 不可用时
退化为 `-1`，默认 sink 渲染成 `cpu n/a`——诊断字段不得成为新的崩溃源。

输出形如 `[db-slow] 32648ms (cpu 12ms): select …`。判据一目了然：

- `cpuMs ≈ ms` ⇒ 这条语句真的在算，是查询问题（查计划 / 索引 / 数据量）。
- `cpuMs ≪ ms` ⇒ 进程在等（被调度饿死 / 阻塞在 IO / 锁），**与这条 SQL 无关**。

本次事故的 32648ms 一条属于后者；有这个字段本可一眼定案。

### 2.4 改造范围

- 9 个具名 ticker：各自内部 `setInterval` 换成 `startMaintenanceTicker`，删掉本地的
  `running` / `unref` / `stop` 样板；对外签名新增一个可选 `phaseOffsetMs`（默认取
  `MAINTENANCE_PHASE[对应键]`），既有调用方与测试不受影响。
- 5 个 `start.ts` 内联 `setInterval`：同样换成 `startMaintenanceTicker`，并把 handle
  纳入现有的 shutdown 清理路径（与既有 `*.unref?.()` + 关停顺序保持一致）。
- `db/client.ts`：`instrumentSlowStatements` 增加 CPU 字段，`logSlow` 签名多一个参数。

## 3. 与 RFC-294 目标架构的关系

- 本次改动落在**平台/基础设施层**与 **bootstrap 装配**，不新增任何跨 bounded context 的
  耦合、不新增 facade、不新增 cross-context 内部 import。
- `services/maintenanceTicker.ts` 是纯原语（无 db、无领域类型，只依赖注入的定时器与
  `onTick`），是 RFC-294 意义上可以直接下沉到 `platform/` 的形状。**本 RFC 先落在
  `services/`**，与它的消费方（14 个都在 `services/` 与 `cli/start.ts`）同层，避免在
  一次调度修复里同时做目录迁移。
  **承担的演进**：把 14 份重复的调度样板收成单一原语，为后续下沉到
  `platform/scheduling/` 准备好唯一入口。
  **留下的债**：该文件的最终归宿是 `platform/`，随下一个触及 daemon 装配的 RFC 迁入，
  迁移时留同名 facade 保 import 路径稳定（本仓 §services 目录组织轻规则）。
- 顺手消除 `daemonCadence.ts:9-21` 自述的一处债：那里列出的「没进表的外挂周期」
  （`backupScheduler.ts:194` 裸字面量、`taskArchive` / `maintenanceRetention` /
  `eventsArchive` 的参数默认值、`pluginGenerationGc` 的模块私有常量）本 RFC 全部收编，
  并补上它说的「没有任何守卫要求新循环进表」这条棘轮（AC-2）。

## 4. 失败模式

| 场景                                  | 行为                                             | 处置                                                                                                             |
| ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 某拍耗时超过一个 `intervalMs`         | 重入守卫使下一拍被跳过（与现状一致）             | 保持；slow-tick warn 会先叫                                                                                      |
| 两个任务相位相邻但前一个跑超了 3 分钟 | 会与后一个重叠                                   | 可接受：重叠面从 14 降到 2；slow-tick 日志给出证据                                                               |
| `onTick` 抛同步异常（非 reject）      | 原语用 try/catch 包住调用本身                    | 定时器回调里的同步抛出会变 uncaughtException 打死 daemon，必须罩住（同 `backupScheduler.ts:288-296` 的既有教训） |
| 相位表漏登记新任务                    | 守卫测试转红                                     | AC-2                                                                                                             |
| `process.cpuUsage()` 在某平台不可用   | 用 try/catch 退化为 `cpuMs = -1`，不影响原有字段 | 诊断字段不得成为新的崩溃源                                                                                       |

## 5. 测试策略

必写用例（`packages/backend/tests/rfc322-maintenance-cadence.test.ts`）：

- **相位表不变量**：每项 `0 < offset < HOUR_MS`；两两互异；相邻间隔 ≥ 3 分钟。（AC-1）
- **登记棘轮**：源码层断言——`cli/start.ts` 与 9 个 ticker 实现文件中，不得再出现
  直接以 `HOUR_MS` / `3_600_000` / `DAEMON_CADENCE.<hourly 键>` 为周期的裸
  `setInterval(`；新增 hourly 循环必须走 `startMaintenanceTicker`。（AC-2）
- **错峰实证**：注入假定时器，推进一个完整 `intervalMs`，记录每个任务的触发时刻，
  断言两两不相等且最小间距 ≥ 3 分钟。（AC-3）
- **原语语义**：boot 拍与相位拍各触发一次；重入时第二拍被跳过；`onTick` reject 被吞且
  不影响后续拍；`onTick` 同步抛出不逃逸；`stop()` 后三种 timer 都不再触发。
- **slow-tick 告警**：注入 `now`，令一拍耗时超阈 ⇒ 恰好一行 warn，含 job 与 durationMs；
  未超阈 ⇒ 零日志。（AC-4）
- **CPU 判别**（`db/client.ts` 单测，注入 logSlow sink）：墙钟超阈但 CPU 极小的一拍，
  日志里 `cpuMs ≪ ms`；正常忙查询 `cpuMs ≈ ms`。（AC-5）
- **回归防护**：既有 `rfc284-daemon-cadence` / `rfc311-maintenance-boot-tick` /
  `lifecycle-shutdown` / `rfc213-backup-retention` / `rfc244-alert-resolved-boot-wiring`
  全绿，证明 boot 首拍语义、关停顺序与日志文案未变。（AC-6）

变异检验：把相位表全部改回 0，**错峰实证**与**相位表不变量**两条必须转红。
