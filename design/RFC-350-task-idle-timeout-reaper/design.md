# RFC-350 —— design

> 前置阅读：`proposal.md`（决策 D1–D14 与能力影响清单）、
> `design/RFC-294-backend-layered-target-architecture/proposal.md` §1 摘要裁决 / §3 目标。

---

## 1. 架构落位（RFC-294 对齐，强制第 8 条）

**bounded context：`task-execution`。** 依据 RFC-294 §3 G2 的 owner 表——`task-execution` 唯一拥有
「Task/NodeRun 生命周期、调度、**恢复**、运行态 ownership」。不活跃收割就是一条恢复/终结策略。

> 明确**不**沿用 `services/limits.ts` 的**落位**先例。资源上限今天挂在
> `modules/system-operations/`，而 RFC-294 §3 G2 白纸黑字写着 system-operations「**不拥有** readiness、
> **task limits** 或 workspace GC policy」——那是待收编的存量债，不是可复制的样板。本 RFC 只复用它的
> **端口形状**（provider-owned persistence + 由 task-execution 提供的 `cancelTask`），落位归 `task-execution`。

新增文件按目标架构分层落位：

```text
packages/backend/src/modules/task-execution/
  domain/idleTimeoutPolicy.ts                     # 纯判据：零 IO、零 Drizzle、零 config
  application/ports/taskIdleTimeoutPersistence.ts # provider-owned 读写口
  application/taskIdleTimeoutReaper.ts            # 中性编排：扫描 → 判定 → 杀 → 终结 → 审计
  infrastructure/sqliteTaskIdleTimeoutPersistence.ts
  infrastructure/postgresqlTaskIdleTimeoutPersistence.ts
  composition/taskIdleTimeout.ts                  # 两个 provider 的装配出口
```

- `domain/` 只依赖中性值对象（时间戳、状态字符串），不 import 任何 `@/db`、`drizzle-orm`、`@/config`。
- `application/` 只依赖本模块 domain/ports 与 `TaskRecoveryOperations`（已存在的模块内端口）。
- `infrastructure/` 实现端口；两个 provider 各一份，不共享 Drizzle 表给外部。
- bootstrap（`cli/start.ts` / `cli/postgresqlDaemonApplication.ts`）是唯一装配点。

**本 RFC 承担的演进 / 留下的债**：

- 承担：新代码 100% 按目标形状落位；判据抽成零依赖纯函数（可被两 provider 与测试共用）。
- 留债：收割仍要调用 `services/task.ts:4125` 的 `cancelTask`（SQLite legacy composition）。这与
  `composeLegacySqliteResourceLimitOperations` 的懒 import 桥同形，是 W4 的存量债，本 RFC **不扩大也不修**它——
  端口上只声明 `cancelTask(taskId): Promise<void>`，由 bootstrap 注入具体实现，PostgreSQL 侧直接注入其
  task-execution 命令（与 `composePostgresqlResourceLimitOperations` 同款）。
- 不新增 facade、不新增 cross-context 内部 import、不往 `routes/` 或 `services/` 平铺层加东西
  （唯一例外：`services/taskArchive.ts:95` 的 `TERMINAL` 常量按 §5 就地改一行，属存量文件的最小修正）。

---

## 2. 「最后一次动作」的精确定义

### 2.1 单个任务的活动时刻

```text
activityAt(task) = max(
  task.started_at,                                  -- 下界：新建任务永不被立刻收割（AC-4）
  task.finished_at ?? 0,                            -- 树内已终态成员的收尾时刻
  max(node_runs.started_at)      for task,          -- 手动 resume / retry 铸出的新 run（哪怕它一个事件都没产出）
  max(node_run_events.ts)        for task's runs,   -- agent 事件（既有 stuck detector 同源口径）
  max(collaboration_gate_operations.committed_at)   -- 人类推进动作（D6）
      where task_id = task
        and operation_kind = 'decide'
        and committed_at is not null
)
```

四类数据源的选型理由：

- **`node_run_events.ts`**：与 `stuckTaskDetector` 完全同源（`sqliteTaskRecoveryOperations.ts:83-105`
  的 `latestEventTsForRun` 取 `ORDER BY id DESC LIMIT 1`，走 `idx_events_node(node_run_id, id)`）。
- **`node_runs.started_at`**：补上「resume 了但立刻失败、一个事件都没产出」这个洞。读 node_runs 本来
  就要读（要拿 pid），零额外成本。
- **`collaboration_gate_operations`**（`packages/backend/src/db/schema.ts:2520`）：RFC-333 之后，
  **评审决策 / 反问答复 / 问题派发决策**三条人类推进路径**全部**在这张表落 `operation_kind='decide'`
  的行（三个写点：`legacySqliteReview.ts:3103`、`legacySqliteClarifyDecision.ts:192`、
  `legacySqliteTaskQuestionDispatch.ts:266`）。一张表覆盖 D6 的全部口径，不用跨 5 张表取 max。
  取 `committed_at`（决策**真的落库**了才算推进）而不是 `updated_at`（含 preparing / failed 的半截尝试）。
- **`tasks.started_at` / `finished_at`**：兜底与树内终态成员。

**刻意不计入**（D6「只算推进任务的动作」）：`review_comments`（评论）、`task_collaborators`（成员变更）、
反问逐题草稿、`task_feedback`。理由写进 `domain/idleTimeoutPolicy.ts` 头注释：一条评论就能无限续命一个
没人推进的任务，那正是本功能要治的形态。

### 2.2 树的活动时刻与僵尸判据（纯函数）

```ts
// domain/idleTimeoutPolicy.ts —— 零依赖、可穷举测试
export interface TaskActivityRecord {
  readonly taskId: string
  readonly status: string // TaskStatus
  readonly activityAt: number // §2.1 的 max
}

export interface IdleTreeVerdict {
  readonly rootTaskId: string
  readonly idle: boolean
  readonly treeActivityAt: number
  readonly silentMs: number
  readonly liveTaskIds: readonly string[] // 树内非终态成员（= 要被收割的那些）
}

export function judgeIdleTree(input: {
  rootTaskId: string
  members: readonly TaskActivityRecord[]
  now: number
  thresholdMs: number
}): IdleTreeVerdict
```

判据（三条同时成立才是僵尸）：

1. `members` 里**至少一个**状态属于 `CANCELABLE_TASK_STATUSES`（`packages/shared/src/lifecycle.ts:444`
   —— 从转移表**派生**，不手抄字面量数组）；
2. `treeActivityAt = max(members[].activityAt)`；
3. `now - treeActivityAt > thresholdMs`。

`liveTaskIds` 是 `members` 里状态可取消的那些（**不含** `interrupted`：它已终态、不可 cancel，
见 proposal §1.1；它的出路是 §5）。

---

## 3. 收割流程

### 3.1 一次巡检

```text
1. persistence.listLiveTaskRoots()        -- 非终态且 deleted_at IS NULL 的任务 → 归到树根
2. 对每个候选根（按最早活动排序，单拍上限 MAX_TREES_PER_SWEEP）：
     a. persistence.loadTreeActivity(rootTaskId)  -- 整树成员 + 各自 activityAt + 非终态 run 的 pid 快照
     b. judgeIdleTree(...)                        -- 纯函数
     c. verdict.idle === false → 跳过
     d. verdict.idle === true  → reapTree(...)
3. 收割了 ≥1 棵树才写日志汇总；一棵没收不写任何东西（AC-8）
```

**树根的确定**：优先用 RFC-311 G1 物化列 `tasks.root_task_id`（`schema.ts` tasks 表，migration 0183 回填）；
该列为 NULL 的 legacy 行沿 `parent_task_id` 向上走（深度上限 64，与 `taskArchive.ts:413` `collectTree` 同款）。
整树成员仍用与归档器同形的自顶向下 BFS（`collectTree`）取，保证「树」这个单位在两个功能里是同一个东西。

### 3.2 单棵树的收割

```text
reapTree(verdict):
  1. 杀进程：对树内每个非终态 node_run 的 pid 调
     killStaleRunProcessTree({pid, startedAt, spawnBinaryPath, spawnLaunchNonce})
     （packages/backend/src/util/process.ts:274；TERM → 1s 宽限 → KILL）
     记录每条 outcome ∈ {no-pid, not-alive, window-expired, command-mismatch, killed, kill-failed}
  2. 终结：对 verdict.liveTaskIds 里的**根**调 cancelTask（它自带 parent→child 级联，
     services/task.ts:4344）；级联没覆盖到的成员逐个补调，已终态的抛 ConflictError 吞掉
  3. 覆盖原因：persistence.writeIdleTimeoutReason({taskId, summary, message})
     —— 与 limits.ts:73-88 的 writeLimitReason 同款「先 cancel 再覆盖专用文案」，
     且同样只覆盖**取消真的落了**的行（竞态里先到终态的行保留它自己的真实原因）
  4. 审计：每个被收割的任务写一条 recovery_events
```

**为什么先杀后取消**：`cancelTask` 只在有活 scheduler controller 时才能 abort 子进程；僵尸的典型形态恰恰是
「controller 没了 / 卡死了」。先杀再改状态，避免留下「库里 canceled、机器上还在写 worktree」的窗口。

**杀不掉怎么办（D11）**：`window-expired`（run 的 `started_at` 早于
`STALE_RUN_PID_MAX_AGE_MS = 48h`，`util/process.ts:181`）与 `command-mismatch`、`kill-failed` 三种 outcome
**都不阻断**终结。特别注意：阈值一旦配到 ≥24 小时，`window-expired` 会是**常见**结果而不是罕见异常——
一个跑了 3 天、最后 25 小时没动静的 run，其 `started_at` 早就超出 48 小时窗口，helper 会拒绝发信号
（它保护的是 PID 复用，不能为本功能放宽）。这不是缺陷，是既有安全网的正确行为；本功能的责任是
**如实记录**并让任务照常终结，剩下的无主进程交给既有孤儿回收。

### 3.3 原因文案（AC-7）

- `error_summary`：`task-idle-timeout`（机器 token，与 `task-time-limit-exceeded` 同级）
- `error_message`：`no activity for {silentMs}ms (threshold {thresholdMs}ms); reaped as an idle task`
- 前端：`packages/frontend/src/lib/task-failure.ts:35-46` 的 `EXACT_TOKENS` 加
  `'task-idle-timeout': 'idleTimeout'`，i18n 补 `tasks.failure.summary.idleTimeout` 与
  `...__hint`。**注意**：`task-time-limit-exceeded` 今天**不在**该表里、落到 generic 文案——本 RFC
  只补自己这一条，不顺手改它的行为（那是独立的既有缺陷，如需修另提）。

### 3.4 为什么不复用 stuck detector 的判定

`stuckTaskDetector` 的 S1–S5 判据是**「静默 + 缺证据」**，并带一串专用豁免：工作组任务的
`awaiting_*` 全豁免（引擎自有 parking）、仓库准备期 45 分钟豁免、call 子任务 pending 30 分钟豁免
（`stuckTaskDetector.ts:110-118`）。这些豁免是为「30 分钟」这个尺度设计的告警降噪，对「24 小时不活跃」
这个尺度既无必要（45 分钟的准备窗口早被 24 小时覆盖）又有害（工作组任务会被永久豁免，而用户 D3 明确
要求**全部非终态状态**纳入）。因此本功能**独立扫描、独立判据**，与 S1–S6 并存互不影响（N6）。

### 3.5 执行位置与节奏（D14）

- **主线程可暂停后台写手**，不进 RFC-338 的维护 Worker。理由：收割要调 `cancelTask`（依赖进程内
  scheduler 的 AbortController / driver stop ticket / WS 广播）与杀进程，Worker 线程只有一条独立 DB 连接，
  拿不到这些。先例就是 `resource-limits`（`cli/start.ts:2729` / `:857`）。
- 注册进 `providerBackgroundWriterFactories`（SQLite：`cli/start.ts:3169`）与
  `backgroundWriterFactories`（PostgreSQL：`cli/start.ts:1005`）。**这是硬要求**：没注册的周期写手会写穿
  RFC-349 的迁移冻结窗口，随后 `sqliteLogicalSource.assertUnchanged` 只能报一句
  `sqlite-source-mutated` 却指不出是谁（STATE.md 2026-09-02 第 14 条实撞）。AC-15 锁这一条。
- 节奏：`DAEMON_CADENCE.taskIdleTimeout = 5 * MINUTE_MS`（`services/daemonCadence.ts:29-` 登记）。
  阈值最细 1 小时，5 分钟巡检把判定延迟控制在阈值的 8% 以内，且扫描面只有**活任务**，成本远低于
  1Hz 的 `enforceLimits`。非 hourly 循环不进 `MAINTENANCE_PHASE`（该表只收周期性重维护，见
  `daemonCadence.ts:22-25`）。
- 单拍上限 `MAX_TREES_PER_SWEEP = 20`（模块常量，**不做成用户旋钮**——D8 已把配置面压到两个字段）。
- 配置每拍热读 `loadConfig(Paths.config)`，改开关/阈值免重启（AC-16），与归档器同款约定。

---

## 4. 端口契约

```ts
// application/ports/taskIdleTimeoutPersistence.ts
export interface IdleTimeoutRunSnapshot {
  readonly nodeRunId: string
  readonly pid: number | null
  readonly startedAt: number | null
  readonly spawnBinaryPath: string | null
  readonly spawnLaunchNonce: string | null
}
export interface IdleTimeoutTreeSnapshot {
  readonly rootTaskId: string
  readonly members: readonly TaskActivityRecord[]
  /** 树内**非终态** node_run 的进程快照（收割时要杀的那些）。 */
  readonly liveRuns: readonly IdleTimeoutRunSnapshot[]
}
export interface TaskIdleTimeoutPersistence {
  /** 非终态且未软删的任务 → 去重后的树根 id，按树内最早活动升序。 */
  listIdleCandidateRoots(limit: number): Promise<readonly string[]>
  loadTreeActivity(rootTaskId: string): Promise<IdleTimeoutTreeSnapshot | null>
  /** 返回「这一行是不是被本次收割认领了」——审计只在 true 时才写，见 F-9。 */
  writeIdleTimeoutReason(input: {
    readonly taskId: string
    readonly summary: string
    readonly message: string
  }): Promise<boolean>
  recordReapAudit(input: IdleTimeoutAuditRecord): Promise<void>
}
export interface TaskIdleTimeoutOperations {
  readonly persistence: TaskIdleTimeoutPersistence
  /** 由 task-execution composition 注入；不在这里伪造 provider 兜底。 */
  readonly cancelTask: (taskId: string) => Promise<void>
  /** 复用既有恢复审计端口（recovery_events）。 */
  readonly recovery: TaskRecoveryOperations
}
```

`writeIdleTimeoutReason` 与 `ResourceLimitPersistence.writeLimitReason`（`resourceLimitPersistence.ts:31-35`）
同形，且同样只更新**当前 `status='canceled'` 且 summary 仍是取消默认值**的行——竞态里被别的终态写手抢先的
行保留它自己的真实原因（`limits.ts:73-79` 记的 RFC-097 audit S-14 教训）。

---

## 5. `interrupted` 树归档补齐（D13 / AC-11）

改动**一行**：`packages/backend/src/services/taskArchive.ts:95`

```ts
-const TERMINAL = ['done', 'failed', 'canceled'] as const
+// RFC-350：与 shared 的 TERMINAL_TASK_STATUSES 对齐。interrupted 同样是终态且带
+// finished_at（orphan reaper 写的），此前被漏掉，导致每次 daemon 重启残留的那批
+// 任务永久不出库。
+const TERMINAL = TERMINAL_TASK_STATUSES
```

直接引 `@agent-workflow/shared` 的 `TERMINAL_TASK_STATUSES`（`lifecycle.ts:203-208`）而不是再抄一份
四元素字面量——那正是 RFC-317 T51 花力气消灭的「六份手抄、同名反义」形态。PostgreSQL 侧
（`postgresqlTaskArchiveMaintenanceCommand.ts`）有同款常量，一并对齐。

**影响面**：仅当 `taskArchive.enabled=true` 且 `finished_at` 过了 `retentionDays` 时生效（能力影响
清单 I-4，用户已确认）。归档器其余判据（整树终态、原子落盘、崩溃恢复、审计）逐字不变。

---

## 6. 配置

```ts
// packages/shared/src/schemas/config.ts —— 紧邻既有 taskArchive
/**
 * RFC-350：任务不活跃超时收割（僵尸任务）。**默认关闭**。开启后，一棵整树都超过
 * idleHours 没有任何动作、且仍有非终态成员的任务树，会被先杀进程再判 canceled。
 * 它只负责「终结」，出库仍由上面的 taskArchive 按 retentionDays 完成 —— 两道闸各管一段。
 */
taskIdleTimeout: z
  .object({
    enabled: z.boolean().default(false),
    idleHours: z.number().int().min(1).max(8760).default(24),
  })
  .default({ enabled: false, idleHours: 24 }),
```

- `packages/shared/src/settingsNumericBounds.ts` 加 `'taskIdleTimeout.idleHours': { min: 1, max: 8760, unit: 'hours' }`。
- **新增 `'hours'` 单位**：`SettingsNumericUnit`（`settingsNumericBounds.ts:11`）与前端
  `NumberRangeUnit`（`packages/frontend/src/lib/formatUnit.ts:3`）各加一个成员，`UNIT_STEPS.hours =
[{factor: 24, key: 'unit.day'}, {factor: 1, key: 'unit.hour'}]`。两处有 parity 测试
  （`packages/frontend/tests/settings-bounds-parity.test.ts`）钉住。
- 下界取 **1 小时**而不是 0/分钟级：小于 1 小时的阈值会与 stuck detector 的 30 分钟尺度打架，也容易把
  正常长跑任务误杀。`enabled=false` 就是「关」，不需要再用 0 表达一次。
- 保存门（`routes/config.ts`）复用既有 bounded-integer 校验，无需新规则。

### 6.1 设置页（AC-13）

新增一张卡片（`packages/frontend/src/routes/settings.tsx`，紧邻既有 taskArchive 卡）：

- `<Switch>` 开关 + `<Field>` 包 `BoundedNumberInput`（`setting="taskIdleTimeout.idleHours"`）——
  全部复用既有公共原语，不落原生元素、不自写 CSS（`CLAUDE.md` §Frontend UI consistency）。
- 开关打开且 `worktreeAutoGc.enabled !== true` 时，卡内渲染一句提示：僵尸任务的 worktree 不会自动释放，
  并指向工作区回收卡（I-5 / D12）。用既有提示样式，不新造组件。

---

## 7. 双 provider

|             | SQLite                                                                                                             | PostgreSQL                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| persistence | `sqliteTaskIdleTimeoutPersistence.ts`（Drizzle + `DbClient`）                                                      | `postgresqlTaskIdleTimeoutPersistence.ts`（`PostgresqlDatabaseClient`）                          |
| cancelTask  | bootstrap 注入既有 legacy 桥（懒 import `services/task.ts`），与 `composeLegacySqliteResourceLimitOperations` 同款 | bootstrap 注入 task-execution 的 cancel 命令，与 `composePostgresqlResourceLimitOperations` 同款 |
| 注册        | `cli/start.ts:3169` `providerBackgroundWriterFactories`                                                            | `cli/start.ts:1005` `backgroundWriterFactories`                                                  |
| 判据        | 共用 `domain/idleTimeoutPolicy.ts`                                                                                 | 同左                                                                                             |

两个 persistence 的 SQL 形状必须等价；用同一组 fixture 跑两遍的对拍测试锁住（见 §9）。

---

## 8. 失败模式

| #   | 场景                                                        | 行为                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | 进程杀不掉（`kill-failed`）                                 | 照常终结，审计记 outcome；日志 `warn`（D11 / AC-6）                                                                                                                                                                                                      |
| F-2 | run 的 `started_at` 超出 48h PID 复用窗口                   | `window-expired`，不发信号，照常终结并记录（§3.2）                                                                                                                                                                                                       |
| F-3 | `cancelTask` 抛 `ConflictError`（竞态里已终态）             | 吞掉，继续处理树内其余成员；不覆盖它的原因文案                                                                                                                                                                                                           |
| F-4 | `cancelTask` 抛 `cancel-transition-starved`（状态持续抖动） | 本树本拍放弃，下一拍重试；不写审计                                                                                                                                                                                                                       |
| F-5 | 一棵树收割中途抛错                                          | 只影响该树；巡检继续下一棵（与归档器 `taskArchive.ts:963-976` 同款隔离）                                                                                                                                                                                 |
| F-6 | 库在迁移冻结窗口                                            | 收割器作为可暂停 handle 已被 stop+drain，不写库（AC-15）                                                                                                                                                                                                 |
| F-7 | `idleHours` 被改小                                          | 下一拍即生效，可能一次收割多棵树；单拍上限 20 棵兜底                                                                                                                                                                                                     |
| F-8 | 树很大（数千子任务）                                        | `collectTree` 深度上限 64、分块查询（`chunkedAll`）；单拍 20 棵封顶                                                                                                                                                                                      |
| F-9 | 任务在判定与收割之间恢复活动 / 自己跑完                     | 竞态窗口最长一拍。`cancelTask` 的 CAS 会拿到新状态；若仍可取消则照收（判定时刻的静默是事实）。若它已自己落到别的终态，原因覆盖认领不到那一行，此时**不写审计、不计入收割数**——给一个刚刚成功完成的任务留一条「因长时间无活动被自动终结」的恢复记录是撒谎 |

---

## 9. 测试策略（`CLAUDE.md` §Test-with-every-change）

**纯函数（首选可断言面）**——`domain/idleTimeoutPolicy.ts`：

- T-1 `judgeIdleTree`：全终态树 → `idle=false`（没有非终态成员就不是僵尸，交给归档器）
- T-2 树内任一成员活动新鲜 → `idle=false`（AC-3）
- T-3 全员静默超阈值 + 有非终态成员 → `idle=true`，`liveTaskIds` 恰为可取消成员
- T-4 含 `interrupted` 成员的树：`interrupted` **不进** `liveTaskIds`
- T-5 边界：`silentMs === thresholdMs` 不收（严格大于才收）
- T-6 刚创建的 pending 任务（`started_at = now`）→ `idle=false`（AC-4）
- T-7 `activityAt` 合成：四类数据源各自单独最大时都能决定结果

**编排层**（注入假 persistence + 假 kill/cancel）：

- T-8 收割顺序：先 kill 后 cancel，且 kill 覆盖全部非终态 run
- T-9 `kill-failed` / `window-expired` 时仍然 cancel（AC-6）
- T-10 `cancelTask` 抛 Conflict 时不写原因、不中断其余成员（F-3）
- T-11 一棵树抛错不影响下一棵（F-5）
- T-12 未收割任何树时不写审计、不写日志汇总（AC-8）
- T-12b 竞态里任务自己跑完（原因覆盖认领不到）⇒ 不写审计、不计入收割数（F-9）
- T-13 `enabled=false` 时一次 IO 都不发（AC-1）
- T-14 单拍上限生效（F-7/F-8）

**provider 对拍**：同一组 fixture 分别灌进 SQLite 与 PostgreSQL persistence，断言
`listIdleCandidateRoots` / `loadTreeActivity` 的输出逐字段相等（AC-15）。

**归档补齐**：

- T-15 全 `interrupted` 树过了保留期 → 被归档出库（AC-11，**先红**：今天必然不通过）
- T-16 未到保留期的 `interrupted` 树不动
- T-17 混合树（`canceled` + `interrupted`）按 `max(finished_at)` 判保留期

**端到端 / 集成**：

- T-18 开启收割 → 造一棵静默树 → 巡检 → 任务变 `canceled`、`error_summary='task-idle-timeout'`、
  `recovery_events` 有 `idle-timeout-reap` 行（AC-2/AC-7/AC-8）
- T-19 收割后开归档、跨过保留期 → 树出库、详情 404（AC-9）
- T-20 `taskIdleTimeout.enabled=true` + `taskArchive.enabled=false` → 只终结不出库（AC-10）
- T-21 软删除任务不被处理（AC-14）
- T-22 收割器在冻结窗口内被 stop+drain（AC-15，参照 `rfc349-sqlite-daemon-pausable-writers.test.ts`）

**前端**：

- T-23 设置页卡片渲染开关 + 阈值，越界值被拒（AC-12/AC-13）
- T-24 `worktreeAutoGc` 关着时提示出现、开着时不出现（AC-13）
- T-25 `task-idle-timeout` 的 summary 渲染成中文文案而非英文 token（AC-7）
- T-26 `RECOVERY_EVENT_KINDS` 补 `idle-timeout-reap`，i18n 完整性测试
  （`recovery-section-kind-i18n.test.ts`）保持绿

每个测试文件顶端写明「它锁的是哪条 AC / 哪条回归」，回归防护命名按 `CLAUDE.md` 要求。

---

## 10. 偏离项（呈用户确认）

| #   | 偏离                                                  | 理由                                                                                          |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| X-1 | 收割器不进 RFC-338 维护 Worker，留在主线程            | `cancelTask` 依赖进程内 scheduler/driver/WS，Worker 拿不到（§3.5）。与 `resource-limits` 同款 |
| X-2 | 仍经 legacy 桥调用 `services/task.ts` 的 `cancelTask` | W4 存量债，不在本 RFC 范围内偿还；端口已按目标形状声明，将来换实现不动调用方（§1）            |
| X-3 | 就地修改存量文件 `services/taskArchive.ts` 一行常量   | 修的是既有缺陷（proposal §1.1），把它挪进模块属于独立重构，不与本功能捆绑                     |
| X-4 | 新增 `'hours'` 单位到 shared/前端两处枚举             | 用户选定小时粒度；复用 `ms` 会让设置页显示成 86400000 这类数字（§6）                          |
