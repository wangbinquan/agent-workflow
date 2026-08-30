# RFC-338 设计 — 重维护 Worker 隔离与每日维护时刻

配套 `proposal.md`。当前状态：Done（2026-08-30）；用户已于 2026-08-28 批准 D1–D11，实施 live baseline 为
`f5f573a533e8527857f47b9cf74023e3629985b1`，final functional exact SHA 为
`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68`。

## 1. 设计不变量

| ID  | 不变量                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | HTTP/WS 主事件循环不得执行重维护 job 的同步 SQLite statement、目录遍历、递归删除或归档文件写入。                                          |
| I2  | Worker 隔离线程，不改变 SQLite WAL 的单 writer 事实；前台最多等待一个有上限的维护写事务。                                                 |
| I3  | 重清理日程与正确性恢复日程是两个概念；选择 daily 绝不能把恢复、journal 收敛或 invariant 检查推迟到次日。                                  |
| I4  | job 的保留期、eligibility、claim、fence、删除与归档结果由原 owner 模块定义；调度器只决定何时/在哪执行。                                   |
| I5  | 每个 job slice 可重放；Worker/daemon 在任意持久化边界退出后都只能得到“未发生”或“同一效果已完成”。                                         |
| I6  | 同一 job/slot 至多一个 durable run；进程内 `running` 布尔值不能作为跨重启唯一性依据。                                                     |
| I7  | active-task 内存快照只是减少无效尝试的提示；物理删除前必须以 durable claim/fence/recheck 作最终裁决。                                     |
| I8  | 配置保存是日程热更新线性化点；已开始的 cycle 保持原 schedule snapshot，下一 slot 才使用新值。                                             |
| I9  | daily 是 IANA 墙钟语义，不退化为固定 24 小时间隔，也不使用 daemon boot 时刻作 anchor。                                                    |
| I10 | Worker 只返回 strict typed result/delta；不能把 `DbClient`、route、WebSocket callback 或任意函数跨 IPC 传递。                             |
| I11 | background/application port 不依赖 Drizzle/SQLite；SQLite connection、SQL、文件布局和 Worker entry 只在 infrastructure/platform adapter。 |
| I12 | RFC-338 的完成只证明 maintenance-induced freeze 被消除；普通同步查询与水平扩展能力必须分别验证。                                          |

## 2. source pin 事实链

### 2.1 当前阻塞链

```text
setTimeout / setInterval callback
  -> startMaintenanceTicker.onTick()
     -> module sweep/archive/GC body
        -> DbClient -> bun:sqlite synchronous statement
        -> readFileSync/appendFileSync/rmSync/directory walk
           └── same Bun event loop as Hono HTTP + WebSocket
```

`db/client.ts` 用一条长期连接为 daemon 服务，并在注释中明确：statement 同步执行，慢查询会冻结全部 HTTP/WS。
`sqliteWriteRetry.ts` 同时明确 WAL 也只有一个 writer。把 Promise/`await` 加在这些调用外层只会改变返回形状，
不会改变同步工作所在的线程。

### 2.2 当前小时任务 inventory

`MAINTENANCE_PHASE` 的 closed inventory 为：

| job                         | 当前入口                  | 当前工作形态                            | RFC-338 class            |
| --------------------------- | ------------------------- | --------------------------------------- | ------------------------ |
| `worktreeGc`                | `gc.ts#startWorktreeGc`   | recovery + 6 段 DB/FS 扫描/删除混跑     | 拆成 recovery 与 cleanup |
| `webhookDeliveryGc`         | `webhook/webhookGc.ts`    | 大批量 body 清空/行删除                 | cleanup                  |
| `eventsArchive`             | `eventsArchive.ts`        | 大表扫描、JSONL append、批量删除        | cleanup                  |
| `retentionSweep`            | `maintenanceRetention.ts` | 多表循环 batch delete                   | cleanup                  |
| `taskArchive`               | `taskArchive.ts`          | 整树导出与事务删除                      | cleanup                  |
| `backupPrune`               | `backupScheduler.ts`      | 备份目录保留期回收                      | cleanup                  |
| `batchImportGc`             | `repoBatchImport.ts`      | 进程内 Map TTL                          | lightweight-main         |
| `pluginGenerationGc`        | `pluginGenerationGc.ts`   | DB/生成目录回收                         | cleanup                  |
| `developmentUploadGc`       | `cli/start.ts`            | 未 claim 上传回收                       | cleanup                  |
| `developmentRetentionSweep` | `cli/start.ts`            | Mission 台账/证据 retention             | cleanup                  |
| `employeeInputGc`           | `cli/start.ts`            | 数字员工输入 artifact 回收              | cleanup                  |
| `intentScratchGc`           | `cli/start.ts`            | scratch GC + 3 条 journal/recovery 混跑 | 拆成 cleanup 与 recovery |
| `tokenAuditGc`              | `cli/start.ts`            | retention delete                        | cleanup                  |
| `lifecycleInvariants`       | `lifecycleInvariants.ts`  | 正确性扫描与结果通知                    | recovery/invariant       |

此外：

- `humanGateRecoveryTicker` 复用了 `startMaintenanceTicker`，但不属于上表的重清理节奏；
- `startWalCheckpointLoop` 每分钟监督、默认每 10 分钟在主同步连接执行 TRUNCATE checkpoint；
- scheduled backup 已有 `backupVacuumWorker.ts` 只读 Worker 先例，但 prune/checkpoint 和其余清理未被隔离。

### 2.3 当前批量不等于主线程可响应

现有实现已经有多处批量上限：events archive 5,000 行且一拍总 budget 200,000，retention delete 5,000，webhook
delivery GC 默认 10,000，task archive export 2,000。但它们仍在同一事件循环连续执行；一个函数里的多个同步批次之间
没有天然的 HTTP 调度机会，单条 statement 或一次递归删除也不可抢占。

因此目标合同必须同时包含：

1. **线程边界**：所有重 body 在 Worker；
2. **锁边界**：短写事务、维护连接快速 BUSY 退让；
3. **工作边界**：每 slice 有行数/项目数/时间预算，完成后回到队列；
4. **恢复边界**：cursor/receipt/lease 可跨 crash。

只做其中任意一项都不足以覆盖用户看到的长时间不响应。

## 3. 目标拓扑与依赖方向

```text
┌──────────────────────────── main event loop ────────────────────────────┐
│ config PUT ──> MaintenanceScheduleCoordinator ──> desired slot         │
│ timer/boot ──> WorkerSupervisor.send(run job/slot/snapshot)             │
│ HTTP status <── in-memory projection <── typed progress/result          │
│ domain owner <── lightweight result delta / broadcast instruction       │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ strict versioned IPC
┌───────────────────────────────▼ maintenance Worker ─────────────────────┐
│ closed job registry -> priority queue -> exactly one runSlice at a time │
│ MaintenanceRunStore (lease/cursor/receipt)                              │
│ module application port -> SQLite/FS infrastructure adapter             │
│ worker-owned bun:sqlite connection (WAL, short busy_timeout)             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ same db.sqlite / archive/workspace roots
                         SQLite WAL + local filesystem
```

依赖方向按 RFC-294：

```text
modules/*/domain
        ↑
modules/*/application  (MaintenanceJobPort / result contract)
        ↑
modules/*/infrastructure/sqlite-fs  (SQL + path implementation)
        ↑
platform/background + platform/persistence/sqlite
        ↑
bootstrap composition (cli/start.ts)
```

具体约束：

- `platform/background` 拥有 schedule、slot、queue、supervision、IPC、run status 与 metrics 的通用机制；
- 各业务模块拥有 eligibility、batch selection、effect、cursor 与 result delta；
- `platform/persistence/sqlite` 提供 Worker connection factory、transaction/busy classification 和 run-ledger adapter；
- `cli/start.ts` 只组合 catalog 与 supervisor，不再手写 14 份 ticker body；
- 不新建一个能随意读取全部 schema、路径和 callback 的 `MaintenanceService` god object。

## 4. 配置与墙钟算法

### 4.1 配置合同

在共享 `ConfigSchema` 增加：

```ts
type MaintenanceSchedule =
  | { kind: 'hourly' }
  | { kind: 'daily'; at: `${string}:${string}`; timezone: string }

maintenanceSchedule: MaintenanceSchedule // default { kind: 'hourly' }
```

实现复用/抽取 RFC-159 已有的 `DailySpecSchema`、`isValidIanaTz()` 和 `computeNextRunAt()` 语义，不复制第二套时区算法。
若为避免 schema 层循环依赖需要抽取 `DailyWallClockSpecSchema`，抽取后的 scheduled-task 与 config 必须共同消费同一个定义。

不引入：

- 本机模糊 timezone abbreviation；
- “server local time” 这种随部署环境漂移的隐式值；
- cron string；
- 固定 `24 * 60 * 60 * 1000` 的 daily interval。

### 4.2 hourly 兼容语义

`kind='hourly'` 保持 RFC-322 的每 job 固定相位与每小时一次最坏发现时间。变化只在于相位 timer 到点后 enqueue
durable run，不再直接执行 body。`MAINTENANCE_PHASE` 可演进为 closed job spec 的 `hourlyPhaseMs` 字段，但原 4～56 分钟
相位在本 RFC 中不得无故改动。

设置页“下一次”显示最早一个尚未到点的 heavy job，并同时标明 hourly staggered，而不是误导为 14 个 job 同刻开始。

### 4.3 daily 语义

`kind='daily'` 每个当地墙钟日期产生一个 heavy cycle slot，slot 内按 closed catalog 的稳定顺序排入全部 cleanup job。

- 正常日期：在 `at` 对应 epoch 启动；
- spring-forward gap：使用该 gap 后第一个有效瞬间；
- fall-back overlap：使用较早实例，较晚实例不再创建第二个 slot；
- 配置在当天时刻之前保存且当天尚未运行：当天可运行；
- 当天已经有 daily cycle 后把时间改到更晚：当天不再运行第二次，从次日生效；
- timezone 改变后，以新 timezone 计算 next，但 unique daily-local-date fence 仍防止一次保存制造即时重复 cycle。

daily 只约束 cycle 的**启动**。所有 job drained 即结束；若 backlog 大，切片可继续越过 `at`。若到下一 slot 尚未结束，
不并发创建第二套 job，只记录一个 coalesced pending signal，当前 cycle 结束后再做一次 catch-up admission。

### 4.4 boot、missed slot 与热更新

- boot 完成 migration/restore/基础 recovery 后，协调器查询 durable ledger；
- 若最近一个应到 slot 没有 run，延迟 30 秒 enqueue 一个 `catch-up`；错过多个 slot 也只补一个；
- 如果该 slot 已 pending/running/succeeded，不重复；failed/stale 走同一 run resume，不建兄弟 run；
- `PUT /api/config` 成功写盘并调用 `notifyConfigApplied` 后，listener 取消旧的**未来 timer**并计算新 next；
- in-flight run 保留入队时的 schedule snapshot，不能被配置变更改写；
- daemon stop 先停止 admission，再请求 Worker drain 当前事务；超过 shutdown grace 才 terminate，重启按 stale lease 恢复。

## 5. closed job catalog 与优先级

### 5.1 catalog

目标使用一个 compile-time closed catalog；每项至少声明：

```ts
type MaintenanceJobSpec = {
  key: MaintenanceJobKey
  owner: ModuleOwner
  class: 'cleanup' | 'recovery' | 'database-internal' | 'lightweight-main'
  priority: 'correctness' | 'foreground-support' | 'cleanup'
  hourlyPhaseMs?: number
  bootDelayMs?: number
  defaultSlice: { maxRows?: number; maxItems?: number; targetWallMs: number }
  workerAdapter?: MaintenanceWorkerAdapterKey
}
```

架构测试要求：

- 每个周期性 SQLite/FS maintenance production entry 都映射到一个 key；
- `cleanup` 必有 schedule/Worker adapter；
- `recovery` 必有原 cadence/Worker adapter；
- `lightweight-main` 不得 import `DbClient` 或使用同步 FS；
- 新增 heavy timer 但不登记会失败；
- worker registry keys 与 main catalog exact 对拍，missing/extra/wrong-class 均失败。

### 5.2 worker queue

Worker 内只有一个 active slice，以免维护任务互相争 SQLite writer。队列优先级：

1. correctness/recovery；
2. foreground-support（checkpoint 等）；
3. scheduled cleanup。

优先级只在 slice 边界抢占。一个同步 SQLite statement 或单次文件系统调用不能被 JS 抢占，因此 adapter 必须把可控工作
拆小；无法硬切的单次调用由 Worker 隔离保证主线程响应，并以 slow-operation metric 暴露。

同 priority 使用稳定 FIFO；一个返回 `more` 的 cleanup slice 放到同级队尾，避免 events archive 永久饿死其他 cleanup。

## 6. Worker 与 IPC 合同

### 6.1 握手

Worker 启动后先返回：

```ts
type MaintenanceWorkerHelloV1 = {
  protocolVersion: 1
  workerId: string
  jobCatalogDigest: string
}
```

主进程在握手完成前不 dispatch；protocol/catalog digest 不一致时拒绝运行、记录明确 degraded 状态并重启受限次数，不能
把未知 job 静默丢弃。

### 6.2 command

```ts
type MaintenanceWorkerCommandV1 =
  | {
      kind: 'admit'
      runId: string
      job: MaintenanceJobKey
      slot: SlotV1
      config: JobConfigSnapshotV1
      activeTaskRefs: string[]
    }
  | { kind: 'cancel-pending'; runId: string }
  | { kind: 'drain' }
  | { kind: 'status'; requestId: string }
```

只有尚未 claim 的 pending run 可以取消；本 RFC 的普通 config change 不取消当前 cycle，所以 `cancel-pending` 主要服务
daemon shutdown/测试和未来明确操作，不成为半途停止 effect 的逃生门。

`JobConfigSnapshotV1` 是 job-owned strict projection，只包含 retention/threshold/path-independent values。Worker 从已知 app/db
root 派生路径；不传整份 `Config`，避免无关设置变成背景 job 的隐式依赖。

### 6.3 event

```ts
type MaintenanceWorkerEventV1 =
  | { kind: 'started'; runId: string; leaseToken: string; at: number }
  | {
      kind: 'progress'
      runId: string
      job: MaintenanceJobKey
      slice: number
      counters: CountersV1
      hasMore: boolean
    }
  | { kind: 'domain-delta'; runId: string; delta: MaintenanceDomainDeltaV1 }
  | {
      kind: 'settled'
      runId: string
      outcome: 'succeeded' | 'failed' | 'deferred'
      errorCode?: string
    }
  | { kind: 'heartbeat'; workerId: string; activeRunId: string | null; at: number }
```

main 对 `domain-delta` 只调用 owner 提供的 lightweight projector/broadcaster；未知 version/kind fail closed 为可见错误，不能把 raw
JSON 直接喂给 UI 或 callback。

## 7. Worker SQLite 连接与前台公平性

### 7.1 connection profile

Worker 在 migrations 完成后开启自己的 SQLite connection：

- 同一个 db path、`journal_mode=WAL`、`foreign_keys=ON`；
- maintenance `busy_timeout` 取很短的固定值；具体数值由实现负载门校准，初始候选 50ms；
- statement slow threshold 单独记录 job/run/slice，不混成无归属的 `[db-slow]`；
- 连接只在 Worker 创建/关闭，不跨线程共享主 `DbClient` 或 prepared statement；
- Worker crash 后连接关闭，SQLite 自动回滚未提交事务。

### 7.2 writer fairness

SQLite 不提供 writer 优先级，本 RFC 用可验证约束实现“维护有效低优先级”：

1. 每个写事务只处理一个 bounded batch；
2. selection/read 与慢文件 I/O 不放在写事务里；
3. maintenance 遇到 `SQLITE_BUSY/LOCKED` 不在同步循环中等 5 秒，立即把 slice 标为 deferred；
4. deferred 使用有上限指数退避和 jitter-free deterministic test seam；
5. 成功写 batch 后也经过最小 cooldown 再竞争下一批；
6. main 报告持续 foreground write pressure/event-loop pressure 时，cleanup admission 延长 cooldown；recovery 仍可进入但保持短事务；
7. 任一维护事务超过目标时长都记 metric，并使 soak 失败，而不是只 warn 后继续宣称完成。

这里的“目标时长”是工程预算，不是假装可中断单条 SQL。初始设计目标为维护写事务 p95 ≤50ms、max <250ms；若
真实大库索引/硬件无法达到，先缩 batch/改查询计划，不能把前台等待阈值放宽来掩盖。

### 7.3 读与磁盘压力

WAL 允许 Worker reader 与前台 writer 并行，但大范围扫描仍可能争 page cache/磁盘。每个 cleanup slice 使用 target wall budget
（初始 250ms）与 cooldown；scheduled soak 同时记录磁盘型 scan 的 API latency。如果某 job 的单 statement 长于 budget，
该 job 必须增加可续 cursor/索引/更窄 scan，而不是在 Worker 中无限读到完成。

## 8. `runSlice` 与副作用恢复

### 8.1 通用合同

```ts
type RunSliceResult<Cursor, Delta> =
  | { state: 'done'; counters: CountersV1; delta?: Delta }
  | { state: 'more'; cursor: Cursor; counters: CountersV1; delta?: Delta; resumeAfterMs: number }
  | {
      state: 'deferred'
      cursor: Cursor | null
      reason: 'busy' | 'active' | 'dependency'
      resumeAfterMs: number
    }
```

每个 owner 定义 strict versioned cursor。cursor 在 slice effect 的 durable linearization point 同事务推进；不能“先把 cursor 往前推，
再尝试删除”，也不能只存在 Worker 内存。

### 8.2 DB-only job

DB-only slice 在单事务内完成：选定 bounded IDs → 条件 delete/update → counters/cursor/receipt。条件谓词必须在写入时重验，
不能只相信事务前 scan。事务回滚后同 cursor 重跑。

### 8.3 DB + 文件系统 job

events/task archive、workspace/input cleanup 不能假装 DB transaction 能原子覆盖文件系统。各 owner 必须使用 purpose-specific
可恢复协议，至少满足：

- 输出/删除目标有 deterministic operation/slice identity；
- crash 后能区分“尚未做”“已完成待 finalize”“需要重试”，不能靠文件是否大概存在猜；
- archive append 不能因“写成功、删行前 crash”在恢复时重复追加；可以使用 staged segment + atomic rename，或经测试证明等价的
  offset/digest journal；
- recursive delete 本身应 idempotent，且执行前后都保留/完成 durable claim；
- 慢文件 I/O 不持有 SQLite write transaction。

本 RFC 不强迫所有 owner 使用同一种 journal 表；它要求每个混合 effect 有可枚举 fault points 和 recovery oracle。

### 8.4 active-task race

```text
main active snapshot ── advisory skip
        ↓
Worker durable eligibility scan
        ↓
claim/CAS (owner-defined)
        ↓
immediately-before-delete durable recheck
        ↓
physical effect
        ↓
finalize/tombstone/receipt
```

若现有 owner 只有内存 `isTaskActive` 而没有足够 durable fence，实施 wave 必须先补 owner-owned claim/fence，再迁 Worker；不能因为
IPC 不方便就删掉该检查，也不能把全局 scheduler internals 注入 Worker。

## 9. durable run ledger

新增 platform-owned `maintenance_runs`（最终命名由 migration 约定决定），最小逻辑字段：

| 字段                                                | 含义                                                 |
| --------------------------------------------------- | ---------------------------------------------------- |
| `run_id`                                            | 稳定 run identity                                    |
| `job_key` / `class`                                 | closed catalog identity/snapshot                     |
| `slot_key` / `scheduled_at`                         | trigger 唯一性；`UNIQUE(job_key, slot_key)`          |
| `cycle_key`                                         | daily heavy cycle 关联；hourly/recovery 可为空或独立 |
| `state`                                             | pending/running/deferred/succeeded/failed            |
| `cursor_version` / `cursor_json`                    | owner strict cursor；done 可空                       |
| `lease_token` / `lease_expires_at` / `heartbeat_at` | crash/stale 接管                                     |
| `attempt` / `slice_no`                              | supervision 与进度                                   |
| `counters_json`                                     | scanned/changed/bytes/backlog 等规范化计数           |
| `error_code` / `error_message`                      | 最近失败；UI 使用稳定 code + 可读摘要                |
| `created_at` / `started_at` / `finished_at`         | 状态与耗时                                           |

约束：

- lease claim、cursor advance、settle 都是 compare-and-swap；旧 Worker 的迟到回执不能覆盖新 lease；
- heartbeat 只是判断 stale 的证据，不代表 effect 已完成；
- succeeded run 不复活；failed 是否自动 retry 由 job policy 决定，但仍是同一 run；
- ledger 只保存调度/恢复元数据，不成为业务记录的第二 owner；
- cursor schema 未知时停止该 job 并显示 migration-required，不丢 cursor 后从头扫。

状态 API 优先读取 supervisor 的 live projection，并用 indexed ledger 补 last run；不能每次打开设置页全表扫描。

## 10. job 拆分与 owner 边界

### 10.1 worktree family

把现有 `startWorktreeGc` 拆为：

- recovery：`recoverInterruptedWorkspaceGc`、claimed webhook workspace prune recovery；保留 boot/原 cadence，高优先级；
- cleanup：proactive worktree GC、iso GC、scratch orphan、deleted-task worktree orphan、partial clone GC；受 maintenance schedule 控制。

`isTaskActive` snapshot 通过 strict active refs 输入，最终删除仍走 durable claim/recheck。六段不再一口气 promise chain 跑完；每段是
closed sub-job 或 cursor phase。

### 10.2 intent family

把 `intentGcTimer` 拆为：

- cleanup：`sweepIntentScratch`；
- recovery：`convergeIntentApplyJournal`、`resumeQueuedIntentWorkingSets`、`convergeResourceBundleApplies`。

若 recovery 最终要调用只能存在于主进程的 runtime/subprocess coordinator，Worker 负责重 scan/claim 并返回 typed action，main 只执行
该 action 的轻量 admission；不能把整个恢复 scan 接回主 timer。

### 10.3 lifecycle/human-gate

Worker 完成 DB scan/decision，main owner 消费 typed delta 做日志、广播或现有 queue admission。正确性语义、boot delay、周期与告警
阈值逐项 characterization，不随 heavy schedule 改变。

### 10.4 archive/retention/webhook

把“while until empty”改成 cursor-driven slice。每个 slice 保持原 retention cutoff/config snapshot；同一 cycle 中途修改 retention 不改写
已经选定的 job snapshot，下一 run 才生效，避免一轮内边界漂移。

### 10.5 WAL checkpoint

`startWalCheckpointLoop` 的监督/间隔语义保留；到点只 enqueue database-internal run。Worker 的短 busy timeout 使活跃 snapshot/reader 下
快速 deferred，下一个监督拍重试；成功才推进 checkpoint waterline。主连接不再执行 TRUNCATE。

## 11. 状态投影与设置页

新增 additive 状态合同，示意：

```ts
type MaintenanceStatusV1 = {
  worker: { state: 'starting' | 'ready' | 'degraded' | 'stopped'; lastHeartbeatAt: number | null }
  schedule: MaintenanceSchedule
  nextRunAt: number | null
  active: null | {
    cycleKey: string | null
    job: MaintenanceJobKey
    startedAt: number
    counters: CountersV1
  }
  last: null | {
    job: MaintenanceJobKey
    outcome: string
    finishedAt: number
    counters: CountersV1
    errorCode?: string
  }
  backlog: Array<{
    job: MaintenanceJobKey
    state: 'pending' | 'deferred' | 'failed'
    since: number
  }>
}
```

UI 规则：

- schedule draft 纳入现有 settings dirty/save/discard 机制；
- daily 选中时立即显示 time/timezone constraints；字段无效不能只靠 disabled save 隐藏原因；
- next/last/current 时间同时显示用户本地格式与 schedule timezone label；
- worker degraded、job failed、backlog 跨 slot 是明确状态，不把“下次时间存在”当成“维护健康”；
- 390px 下字段单列，状态列表不制造横向溢出；键盘与 label/error 关联沿用共享 Field 原语。

## 12. failure matrix

| 故障点                               | 目标行为                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------- |
| config 保存失败                      | 旧 timer/next 不变；未持久化值不热应用                                     |
| timer 重复触发                       | unique slot 返回同一 run，不双跑                                           |
| daemon 在 dispatch 前退出            | boot catch-up 创建/恢复同一 slot                                           |
| Worker 握手失败/协议不匹配           | 不执行 job；状态 degraded；有界重启并记录明确原因                          |
| Worker 事务中退出                    | SQLite 回滚；lease stale 后同 cursor 重跑                                  |
| Worker commit 后、IPC 前退出         | ledger/receipt 已完成；新 Worker 读取 durable 状态，不重复 effect          |
| DB busy                              | 当前 slice deferred + backoff；不占主 event loop、不推进 cursor            |
| archive 文件写后、DB finalize 前退出 | owner effect journal/segment 识别已写内容，完成或安全重试，不重复 append   |
| 目录已被其他 owner 删除              | idempotent success/finalize；不永久 failed                                 |
| scan 后任务重新 active               | durable recheck/CAS 失败，slice deferred/skipped，不删 active 目标         |
| daily job 未在次日 slot 前完成       | 不并发；合并 pending signal并持续显示 backlog                              |
| timezone/DST 变化                    | slot 由保存的 IANA + local date/epoch 计算，每当地日期至多一次             |
| daemon shutdown                      | 停止新 admission，给当前事务 drain；超时 terminate 后依 durable lease 恢复 |
| 磁盘满/归档不可写                    | 不删对应 DB 行；run failed/deferred 且状态可见                             |
| cursor version 未知                  | job 停止并报 migration-required；不清空 cursor 从头执行                    |

## 13. 测试与性能证据

### 13.1 普通门中的确定性测试

- fake clock：hourly phase、daily/DST、hot apply、missed/coalesced slot；
- fake worker：握手、迟到消息、crash/restart、lease fencing、queue priority/fairness；
- synthetic 2 秒同步 Worker body + 真实 HTTP/WS socket，证明 main loop 持续响应；
- SQLite 两连接竞争：maintenance busy/backoff、短事务、foreground write max wait；
- per-job characterization：输入数据、原结果、新 Worker 结果逐字段/逐文件相等；
- fault injection：每个 DB/FS linearization point 前后退出；
- architecture/source guard：catalog closed、heavy main-timer calls=0、lightweight-main 不碰 DB/sync FS；
- config/route/frontend/component/E2E：draft/save/error/status/next-run/390px/keyboard。

### 13.2 scheduled 大库并发 soak

复用 RFC-311 seed 量级，但不复用其“warmup + 5 次顺序 `app.request`”作为并发结论。soak 启动真实 bound server，至少包含：

- 100k tasks、3M node runs、约 10M events/webhook/retention 数据；
- 50 concurrent mixed clients 作为常规 gate，100 clients 作为 scheduled soak；
- read/detail/list、foreground write、WebSocket heartbeat 同时持续；
- 依次/组合触发 events archive、retention、webhook GC、task archive、worktree FS GC、checkpoint；
- control window 与 maintenance window 使用相同硬件/seed，报告绝对值和比值。

必须输出：API p50/p95/max、HTTP error/timeout、WS max gap、event-loop max gap、foreground write wait、SQLite busy/defer、
每 job rows/items/bytes per second、slice p95/max、总 backlog 与完成时间。只报告维护吞吐、不报告用户请求延迟不算证据。

### 13.3 硬阈值

- synthetic Worker block：event-loop gap <500ms，HTTP/WS 无 >1s gap；
- 大库门：maintenance-attributed 全站停顿 ≥1s 次数为 0，HTTP/WS 错误率 0；
- maintenance write transaction：p95 ≤50ms、max <250ms；foreground write attributable wait <1s；
- job 结果与 characterization oracle 一致；backlog 必须可解释并在报告中给出 drain rate。

若托管 runner 的绝对 I/O 差异使 SQL transaction 阈值不稳定，允许先按 source pin 上的 control ratio 校准一次并回填 RFC；不得在失败后
临时放宽而没有用户批准，也不得删除“无 ≥1s 全站停顿”这一用户结果门。

## 14. PostgreSQL/多实例后续路径

RFC-338 为后续工作建立以下 seam，但不实现后续工作：

1. module job 依赖 application ports，不直接依赖 SQLite；
2. run ledger/lease/slot 是存储中立合同；PostgreSQL adapter 可使用事务锁/`SKIP LOCKED` 实现同一语义；
3. coordinator/worker IPC 可以替换为外部 durable queue，而 job contract 不变；
4. UI status/config 不依赖 SQLite 私有字段；
5. closed job catalog 明确哪些工作需要数据库、共享文件存储或 execution-node local cleanup。

后续独立 RFC 至少要处理：

- 303 个 `DbClient` / 258 个 schema import 的端口化与异步连接池；
- transaction contract 从 `dbTxSync` 迁移；
- API/control plane 无状态化与 session/pubsub；
- worktree/artifact/archive 从本机路径变成 execution-worker/storage ownership；
- single-instance lock 的替代与 exact-once scheduler/lease；
- 真实多实例 failover、扩缩容与并发负载门。

在这些门完成前，RFC-338 文案与发布说明只能说“维护不再卡住 API 事件循环”，不能说“平台已经支持任意多人水平扩容”。

## 15. 与既有 RFC 的关系

- **RFC-311**：保留其索引、保留期、阈值、batch 与 VACUUM Worker成果；补齐当时明确排除的 maintenance write/第二连接隔离，
  不倒签其“普通查询 Worker/read pool”非目标。
- **RFC-322**：hourly 模式保留相位/slow attribution；把“错峰”升级为“enqueue 到 Worker”。daily 模式新增 wall-clock，
  但不否定 RFC-322 的诊断价值。
- **RFC-159**：复用 daily/IANA/DST 纯算法，不复用 scheduled task 的 launch payload/业务表。
- **RFC-294**：新代码落 platform background/persistence 与模块 application/infrastructure 边界；不继续扩大 legacy `services/` god wiring，
  也不把本 RFC 记作 PostgreSQL 或全仓模块化 wave 完成。

## 16. 最终实现与 hosted 证据（2026-08-30）

- `maintenance_runs` durable slot/lease/cursor、closed catalog/protocol、schedule coordinator、Worker supervisor 与独立
  SQLite profile 已落位；主进程只 admission、接 typed delta 和投影状态，Worker degraded 时不回退执行重 body。
- token/webhook/retention/events 与两类临时上传 GC 已有有界可恢复 slice；worktree cleanup 按 phase 让步；其余存量
  owner 的 durable claim/fence 保持并只从 Worker 调用。human-gate scan 也改为 Worker 读 + main typed wake，
  correctness 不等 daily。
- 真实 socket 回归在 Worker 连续 2 秒同步阻塞时维持 HTTP/WS 响应；两 SQLite 连接竞争证明 maintenance 在 50ms
  busy budget 内退让并以同 cursor 续跑；active-workspace scan race、Worker late event、心跳超时自动替换与
  running+queued crash 已锁。
- 编译二进制初次验收发现 `new URL(...).href` 生成 `/$bunfs/root/...` 后 Bun 无法匹配独立 Worker entry；编译态现改用
  relative entry string，开发态继续用 file URL。重建后设置页 Worker 为 `Ready`，同型 backup Worker 一并修复，并新增
  compiled-binary E2E 防止只在源码测试里假绿。
- 设置页在 390px 实际浏览器中完成 hourly→daily 键盘切换；空时间与无效 IANA 时区同时给出字段错误，未保存草稿不写配置。

- 50-client/full-seed 正式门复用 100k tasks / 3M node runs / 10M events / 100k webhook deliveries / 500 repos，
  control/maintenance 各 60 秒。维护窗口 API max 385.2ms、foreground write max 359.0ms、WS max gap 573.6ms、
  event-loop max gap 371.5ms，HTTP/WS error/timeout 为 0；50,636 条 Worker SQLite statement 的 p95 上界为
  50ms、max 78.2ms。完整指标、backlog/drain rate 与第一次 445.3ms 反例的修复说明见 `verification-report.md`。
- RFC338 目标与 owner/perf 回归 109/109、shared 3/3、frontend 2/2、compiled-binary Chromium E2E 1/1 通过；
  AC-7/8/12 的 fault/characterization/mutation receipts 已统一对账。
- 主实现 `a6d97ccf4870a64730e7f3d8a88531fad2f56577` 与最后一笔 RFC-338 专属 source fix
  `e3433b76b0495a69dd9ab1b5d78994afe00763ca` 均为 final functional exact SHA
  `c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` 的祖先；该 SHA 也为当前已发布 `main` 的祖先。
- final exact SHA 的 Main CI `33298828254` 共 35 jobs，failed/unfinished 均为空。相同 SHA 的 full
  `33298851279`、webkit `33298852761`、evidence `33298851076`、git `33298851691`、integration
  `33298851086`、maintenance `33298851934`、visual `33298851050`、windows `33298851033` 全部
  `completed/success`。
- maintenance run `33298851934` 使用 100 clients、full seed、control/maintenance 各 180 秒并 PASS。维护窗口
  API p50/p95/max 为 58.7/127.1/250.0ms，foreground write max 203.5ms，WS max gap 357.9ms，event-loop
  max gap 151.9ms，错误 0；123,996 条 SQLite statement p95≤50ms、max 131.1ms。events backlog
  10,000,000→9,055,000，webhook deliveries 100,000→0；未清空的 events 以 durable `running` cursor 续跑，
  不是隐藏为成功。artifact `9728401544` 的 digest 为
  `sha256:66d8b49f4f3a98c329645c98cf1bdd92aff0af5a21bd783f3209040e41e77ee0`。

AC-1～AC-13 至此全部闭合，RFC-338 为 Done。该结论只覆盖 maintenance-induced freeze；不外推为 PostgreSQL、
普通 query pool、多实例或水平扩展已经完成。
