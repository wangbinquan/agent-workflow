# RFC-391 设计：中立应用图

研究基线 HEAD `02dae8e7f`（行号以实施时源码为准）。缩写：

- `S:` = `cli/start.ts`
- `P:` = `cli/postgresqlDaemonApplication.ts`
- `V:` = `server.ts`
- `L:` = `cli/daemonLifecycleProgram.ts`
- `B/x` = `cli/daemonModules/x.ts`
- `T/` = `packages/backend/tests/`

其余路径相对 `packages/backend/src/`。研究笔记见本会话 2026-10-21 的只读研究（57 个构造步骤、34 个启动步骤逐项对照，149 个测试逐文件分类）。

## 1. 现状

### 1.1 两条会话路径

- `startCommand`（S:1579-1987）准备一份约 80 键的 `sessionInput`，初始会话与迁移目标会话都经 `composeDaemonProviderSession`（S:1395-1403）按 provider 查表，
  进入 `composeSqliteProviderSession`（S:1994-3216）或 `composePostgresqlProviderSession`（S:574-1240）。
- PostgreSQL 会话再调 `composePostgresqlApplication(input, { kind: 'daemon' })`（P:470-1151）。该函数另有 `{ kind: 'unstarted', scope }` 测试相位，
  被 `T/helpers/providerHttpApplication.ts` 的 PostgreSQL lane 使用。
- 两个会话的产出进同一个中立运行时会话（S:539-562）；`startCommand` 只读 `application.core.authRuntime`（S:1975）。

### 1.2 差异分类（57 个构造步骤）

| 类别 | 数量 | 内容 |
| --- | --- | --- |
| 同一工厂、写两份 | 30 | 模块组、作业工厂、已提交事件、关闭参与者、`initialize`、运行时会话等 |
| 只差输入 | 15 | 路径标量（`Paths.*` 与 `input.*`）、托管选择、测试接缝、适配器表取值 |
| 真正的 provider 机制 | 5 | 开库（SQLite 需 `migrationsFolder`，S:2046 / S:587）；恢复钩子（SQLite 在 `startCommand` 开库前 staged restore，S:1642-1665；PostgreSQL 冷恢复在核心组之后、仅 daemon 相位，P:571-577）；维护服务四个输入（`provider`、`fileSnapshotInFlight`、准入存储、Worker 开库参数，S:2500-2530 / S:694-712）；定时备份（S:2695-2705 / S:1019-1036）；托管选择准入（S:1999，25 个托管专属键） |
| 漂移 | 7 | 见 §1.3 |

### 1.3 漂移

| 编号 | 内容 | 处置 |
| --- | --- | --- |
| D1 | 维护 Worker 的 `activeTaskIds`：SQLite 为驱动注册表 ∪ `materializingSpaces`（`services/task.ts:331-338`），PostgreSQL 只有驱动注册表（B/taskExecution.ts:372-373）；Worker 用它保护物化中任务（`modules/task-execution/composition/workspacePreparationMaintenance.ts:82-90`） | 取并集（proposal §4） |
| D2 | SQLite 资源上限每 tick 新建 `composeLegacySqliteResourceLimitOperations(db)`（S:2653）、空闲收割每次取消新建 `composeTaskCancellation(db)`（S:2667）；PostgreSQL 用会话的取消命令（P:821-836） | 两边都用会话的取消命令 |
| D3、D4、D6 | 日志组件名与文本；SQLite 托管 Worker 多 `done.catch` 日志（S:2466-2470、S:2482-2486）；`resource-reverify` 多一层 catch 日志（S:2617-2638） | 取信息更全的一份 |
| D5 | SQLite 不向 HTTP 透传 4 个非托管选择（`resourcePackageSkillArtifacts` / `resourcePackagePluginArtifacts` / `resourcePackageSkillContent` / `workspaceContent`） | 两边都透传（单机生产为空） |
| D7 | `hosted-targeted-resume`：SQLite 空函数（S:3158-3160），PostgreSQL 真实实现（P:1083-1094）；只在 crewstation profile 执行（L:189-191） | 用 PostgreSQL 实现 |

### 1.4 启动步骤与证明世代

- 生命周期程序按 `DAEMON_BOOT_STEPS` 的声明顺序执行 34 步（L:23-81、L:258-319）；受 `providers` 限制的步骤，在不适用的 provider 上**必须**是 `NotApplicable`
  （L:192-199，`T/rfc379-daemon-lifecycle.test.ts:149-157`）。
- 34 步中 26 步两侧逐字等价（PostgreSQL 有 4 步写在会话层）。
  - 受 provider 限制：`repository-url-sealing`（SQLite）、`daemon-identity`（PostgreSQL）。
  - 只差输入：`git-credential-lease-cleanup` 的路径、`task-execution-recovery` 的证明世代。
- 证明世代：
  - SQLite 用 `readDaemonStartupRecoveryAuthority(lock, DAEMON_GENERATION)`（S:3107-3123）。
  - PostgreSQL 守护进程总传 `daemonStartupLease: input.lock`（S:671），实际走 `readDaemonStartupRecoveryAuthority(lease, runtime.generationId)`；
    P:1043-1048 的 `createDaemonLockProof(DAEMON_GENERATION)` 在守护进程中不可达。
  - 执行 owner 一律打 `DAEMON_GENERATION`（RFC-385），与 PostgreSQL 的库世代证明必然不同，回收成立。
  - RFC-385 设计里「单机锁证明改用 `DAEMON_GENERATION`」改的正是这个不可达分支，在此更正记录。

### 1.5 构造顺序

- PostgreSQL：迁移模块 → 应用（含 HTTP）→ 维护服务。HTTP 的维护状态靠闭包晚读（S:686）。
- SQLite：维护服务 → 迁移模块 → HTTP。维护服务的 apply 活动靠闭包晚读（S:2537）；这一顺序被 `T/architecture/rfc390-neutral-http-binding.test.ts:204-221` 钉住。
- 共同约束：
  - 意图组先于维护服务（RFC-384，`T/architecture/rfc380-daemon-module-bundles.test.ts:391-438`）；
  - PostgreSQL 冷恢复在核心组之后、其余模块组之前。

## 2. 设计

### 2.1 应用图（G1）

`bootstrap/daemonApplication.ts`：

```ts
export type DaemonApplicationPhase =
  | { readonly kind: 'daemon' }
  | { readonly kind: 'unstarted'; readonly scope: UnstartedApplicationScope }
export function composeDaemonApplication<P extends DatabaseProvider>(
  input: DaemonApplicationInput<P>,
  phase: DaemonApplicationPhase,
): Promise<DaemonApplication<P>>
```

- **输入**：
  - 已开好的数据库与 provider 运行时句柄（守护进程由会话图开库，测试由 harness 借出）；
  - 路径（`appHome`、`configPath`、`daemonInfoPath`、`lockPath`，守护进程传 `Paths.*`）；
  - 配置绑定、会话标量、迁移模块、可选的维护状态闭包与启动租约；
  - 部署选择：今天的约 50 个可选键，S2c 再类型化；
  - 测试接缝：今天 PostgreSQL 应用上的 7 个。
- **构造顺序**：
  1. 实时策略 → 核心组 →（daemon 相位）适配器的「核心组之后」钩子（PostgreSQL 冷恢复）；
  2. 观测 → 资源目录 → 仓库凭据 → 记忆 → 任务执行 → 工作区维护 → 融合 → 定时任务 → 集成身份 → 集成 → 数字员工 → 开发自动化；
  3. 资源上限 / 空闲收割操作（会话取消命令）→ 意图；
  4. HTTP（V 的 `composeProviderAppComposition` + `composeProviderAppDeps` + `createComposedApp`）+ WS；
  5. 33 步启动步骤记录（不含要维护服务的 `maintenance-boot-snapshot`）。
- **输出**：核心组、12 个模块组、会话级操作（含资源包 apply 活动）、`app`、`webSocket`、启动步骤记录。
- **测试相位**：`phase` 只决定是否跑「核心组之后」钩子、MCP 诊断由谁构造、未启动期的有限初始化，不决定其他构造。
- 受 provider 限制的两个启动步骤：从 `DAEMON_BOOT_STEPS` 的声明读适用 provider，不适用即 `NotApplicable`（一个小助手，`L` 仍是唯一事实源）。
- `task-execution-recovery`：`createDaemonRecoveryAuthorityProof(readDaemonStartupRecoveryAuthority(lock, adapter.recoveryProofGeneration))`，只此一种写法。

### 2.2 会话图（G2）

`bootstrap/daemonSession.ts`：`composeDaemonSession(input: DaemonProviderSessionComposeInput): Promise<ComposedDaemonProviderSession>`，
输入输出沿用今天 S 的类型（S:1243-1343）。按以下顺序构造：

1. 适配表选择、托管选择准入、开库、迁移模块；
2. `composeDaemonApplication(…, { kind: 'daemon' })`；
3. 维护服务（适配表四件套；`activeTaskIds` = 驱动注册表 ∪ 正在物化的任务；apply 活动读应用产出）；
4. 维护 / MCP / 任务执行三个惰性绑定；
5. 7 个轮询作业、2 个托管 Worker、5 个手写 handle、已提交事件、3 个关闭参与者；
6. `composeDaemonLifecycle`（全仓唯一一次；步骤 = 应用的 33 步 + `maintenance-boot-snapshot`）→ `initialize` → 运行时会话。

托管选择（`crewStationEvents`、`repositoryRemote`、`humanGateArtifactRecovery`、`hostedBackgroundOwners` 等）统一沿用「有则用、无则本地」的写法，不做 provider 判别。

### 2.3 适配表（G3）

`DAEMON_SESSION_ADAPTERS`（`satisfies Record<DatabaseProvider, …>`，与 `bootstrap/maintenanceWorkerGraph.ts` 的适配表同形）：

| 字段 | SQLite | PostgreSQL |
| --- | --- | --- |
| `open()` | `runtime.openClient({ migrationsFolder })` | `runtime.openClient()` |
| `admitSelections` | `standaloneSelectionsOf`（拒绝托管专属键） | 原样 |
| `core(db)` | `DAEMON_PROVIDER_CORE_ADAPTERS.sqlite(...)` | `DAEMON_PROVIDER_CORE_ADAPTERS.postgresql(...)` |
| `taskExecution(db)` | `DAEMON_TASK_EXECUTION_ADAPTERS.sqlite(...)` | `DAEMON_TASK_EXECUTION_ADAPTERS.postgresql(...)` |
| `afterCore(core)`（仅 daemon 相位） | 无 | `core.systemOperations.applyPendingRestore()` |
| `maintenance(config, db)` | `provider`、文件快照进行中判定、SQLite 准入存储、Worker 开库参数 | `provider`、`() => false`、运行账本准入、Worker 开库参数 |
| `scheduledBackup(core)` | 文件备份 | 系统运维备份（托管 `databaseBackup` 优先） |
| `recoveryProofGeneration` | `DAEMON_GENERATION` | `runtime.generationId` |

### 2.4 入口根装配（G4）

- `startCommand` 的会话组合改为由调用方注入；`main.ts`（部署分支门豁免）导入 `bootstrap/daemonSession.ts` 并传入。
- `cli/dev.ts` 的 `reloadDevelopmentDaemon` 不再以 `startCommand` 作默认值：`main.ts` 本就把自己的 `start` 交给它。
- `cli/start.ts` 只类型依赖会话输入输出（类型留在 S 或中立的 `cli/daemonProviderSession*` 文件），不导入 `bootstrap/`。
- RFC-389 的入口常量模块改由会话图导入。`T/architecture/rfc294Gates.ts` 中为它加的 `isMaintenanceWorkerEntryPathModule` 特判失去生产用途，删除，连同其负例。
- 直接调用 `startCommand` / `serveDaemon` 的测试改为传入会话组合函数。

### 2.5 删除（G5）

- 删除的函数与文件：
  - S 中的 `composeSqliteProviderSession`、`composePostgresqlProviderSession`、`composeDaemonProviderSession` 查表，以及只为它们存在的私有件；
  - `cli/postgresqlDaemonApplication.ts` 整个文件（其 unstarted 相位由应用图承接）。
- `standaloneSelectionsOf` / `HOSTED_ONLY_SELECTIONS` 随适配表迁出：`T/rfc370-v9-*` 在用，迁出后从新位置导出。
- 只服务被删路径的 `composeLegacySqliteResourceLimitOperations` 生产调用、SQLite 侧 `composeTaskCancellation` 的会话内构造随之消失；
  函数本身若失去全部消费者则删除。

## 3. 失败模式

- 冷恢复跑在模块组读表之后：由「冷恢复只在 daemon 相位、早于其余模块组」的行为用例与结构锁锁定。
- 漏给受限步骤的 `NotApplicable`：生命周期程序启动即抛（L:192-199），由两个 provider 的启动用例覆盖。
- 迁移切换在同一进程再组一次 PostgreSQL 会话：由 `T/rfc349-database-migration-operations.test.ts` 等真起守护进程的用例覆盖。

## 4. 守卫与账本（同提交修订）

- **架构清单与守卫**：
  - `BOOTSTRAP_FILES`：加入新文件，去掉 P。
  - commons-debt：P 的一条 R1（`task-execution/infrastructure/taskDeleteRecovery`）随删除销账，图里改走 `@/services/taskDelete` 再导出。
  - RFC-379 守卫：`ROOTS` 加新文件；L3 改为「生产语料恰一次 `composeDaemonLifecycle`，位于会话图」。
  - RFC-380 守卫：`ROOTS` 改为 {应用图, V 测试路径}；RFC-384 顺序规则改为单函数。
  - RFC-390 守卫：`ROOTS` 改为 {应用图, V 测试路径}；`HTTP_OWNERS` 扫描面加新文件；SQLite 顺序断言改写为「维护服务读应用产出的 apply 活动」。
  - t19c 两张逐字账本与 `DAEMON_ENTRY_FILES`；t17 账本删 P 一行；适配器生产消费者下限随 P 删除下调。
  - identity-access 两张精确清单（`T/rfc305-architecture-lock.test.ts`、`T/rfc347-identity-access-runtime.test.ts`）；RFC-385 / RFC-370 启动租约钉子；RFC-389 守卫（入口常量改由会话图导入）。
  - `deployment-mode-branch-sites` 清单（删除 RFC-389 特判后实测不升）；guard-manifest。
- **CI 路径过滤**：`.github/workflows/windows-platform.yml`、`.github/workflows/maintenance-soak-nightly.yml` 加入新文件、删除 P。
- **测试改指**：研究清单 95 个必须改写的测试文件（架构守卫 12、RFC-370 根绑定族 25、RFC-359 / RFC-349 源码锁约 30、其余约 28），以及唯一导入 P 的 helper
  `T/helpers/providerHttpApplication.ts`（PostgreSQL lane 改调应用图的 unstarted 相位，SQLite lane 不动）。
  - 大量断言钉的正是「两份」本身：每文件恰好 2 次、按 `backgroundJobs` 下标区分 provider、两种拼写、文件内物理顺序。
  - 改写为「图里一份 + 适配表两项」，保持断言意图，不得删除或放宽。

## 5. 测试策略

1. 既有双引擎用例全部通过，不改断言意图；重点是真起守护进程的用例：
   - `T/daemon-start.test.ts`、`T/cli.test.ts`；
   - `T/rfc349-database-migration-operations.test.ts`、`T/rfc349-database-cli.test.ts`、`T/rfc349-daemon-provider-runtime-handles.test.ts`；
   - `T/rfc359-w43-daemon-setup-diagnostic.test.ts`、`T/rfc370-m0-hosted-control-plane.test.ts`；
   - 以及 Playwright e2e。
2. 新增行为用例（双引擎）：
   - 两个 provider 的启动步骤记录出自同一份实现；
   - 冷恢复只在 PostgreSQL daemon 相位、早于资源目录组；
   - SQLite 拒绝托管选择；
   - PostgreSQL 维护保护集含物化中任务（「旧接线」对照显示原先不含）。
3. 结构锁（新守卫，登记 guard-manifest）：
   - 应用图与会话图各唯一；`composeDaemonLifecycle` 全仓一次；
   - 被删函数与文件不存在；
   - 图与适配表里无 provider 字面量比较；
   - `cli/start.ts` / `cli/dev.ts` 不导入 `bootstrap/`；
   - 适配表字段集合精确。
4. 文档：
   - `docs/dev-gotchas.md` 中把 S / V / P 称作三个组合根、描述 W29 摘要守卫的段落已过时，改写；
   - `docs/audit-backlog.md` 中引用 P 行号处改指。

## 6. 与 RFC-294 目标架构的对齐

两个 provider 的会话装配合为 `bootstrap/` 里的一张应用图 + 一张会话图，provider 只是适配表的选择，入口根（`main.ts`）把图交给守护进程机制，达成 S2b 的
「每模块每进程构造一次、不存在 provider 专属装配函数」。

留下的债：

- SQLite 测试 lane 与 `AppDeps`（RFC-392）；
- `composeProviderAppComposition` 仍在 `server.ts`（RFC-392 删测试路径后迁入 `bootstrap/`）；
- 入口根瘦身与 `cli/` ↔ `bootstrap/` 互依（S2c）。

偏离项见 proposal §6 第 8 条。
