# RFC-379 设计：守护进程唯一生命周期程序

基线 HEAD `f8d2d689f`。`S:` = `packages/backend/src/cli/start.ts`，`P:` = `packages/backend/src/cli/postgresqlDaemonApplication.ts`，
`V:` = `packages/backend/src/server.ts`，`RS` = `cli/daemonProviderRuntimeSession.ts`，`H` = `cli/daemonProviderRuntimeHandles.ts`，
`T/` = `packages/backend/tests/`；其余路径相对 `packages/backend/src/`。行号仅作定位提示。

## 1. 现状

### 1.1 会话清单

| 列表 | PostgreSQL | SQLite | 差异 |
| --- | --- | --- | --- |
| 运行时作业 | S:1348-1353 | S:4337-4342 | 同序：`intent-queued-resumption`、`task-execution`、`maintenance`、`mcp-runtime-tests` |
| 后台作业 | S:1354-1372 | S:4370-4385 | 集合相同、顺序不同；PostgreSQL 追加 `hostedBackgroundOwners`（托管 3 项） |
| 收尾参与者 | S:1373-1380 | S:4412-4419 | 同序：`memory-distill-recover-running`、`task-execution-final-close`、`maintenance-final-close`、`mcp-runtime-tests-final-close`、`task-execution-graceful-shutdown`、`webhook-terminal-control` |

RS 按声明顺序启动（运行时先、后台后）、逆序停止、逆序排空，然后按声明顺序执行收尾（RS:133-388）。`state()` 只有
`{phase, activeHandleIds}`，没有生产读者。

### 1.2 启动步骤

SQLite 在 `composeSqliteProviderSession`（S:2133-4436）里与构造交错执行；PostgreSQL 一部分在 `composePostgresqlApplication`
（P:713-2940，`phase.kind === 'daemon'` 守卫）的组合过程中执行，其余在 `initializeExecution` 闭包（P:2706-2870）里——单机内联、
托管由 `bootstrap/executionInitialization.ts` 推迟到执行权激活之后。逐步清单、读写面与依赖见 §3 的表。

### 1.3 组合期副作用

| 副作用 | 位置 | 处置（§4） |
| --- | --- | --- |
| 维护服务定时器、配置监听、启动意图快照、Worker 创建随即排空 | `platform/background/maintenanceService.ts:315-631`，Worker `maintenanceWorkerSupervisor.ts:388` | 构造被动；作业启动时开始 |
| MR 终止 5 秒定时器在启动对账里装上 | `modules/integration/application/mrTerminalControlWorker.ts:47-51, 82-86` | 对账不装定时器；作业启动时装 |
| SQLite MCP 运行时测试即刻启动再暂停 | S:3129；`modules/resource-catalog/application/mcps/runtimeDiagnostics.ts:104-130` | 两个 provider 都在会话恢复时启动 |
| 事件目录登记在 `composeEventCenter` 里 | `modules/event-center/composition.ts:366` | 拆为 `prepare` 步骤 |
| authoring 构造函数分离启动初始化 | `modules/digital-employee/application/authoringService.ts:322-327` | 显式 `initialize()`，`ready()` 惰性触发 |
| 内置工具目录在组合时读一次 | `modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog.ts:91-137` | 拆为 `prepare` 步骤（在模板之后） |
| SQLite HTTP 组合里第二次运输连接投影对账（`void`，无 catch） | V:2020 | 删除（S:2261 已执行） |
| 资源复核 `void` / `whenActive` 之后 | S:3829 / P:2877-2898 | `post-ready` 跟踪的分离步骤 |
| 进程全局登记：终态工作区清理策略、蒸馏策略提供者 | S:2190 / P:821；S:3975 / S:1094 | 每次会话恢复时登记 |

### 1.4 关停

宿主关停顺序（`modules/system-operations/application/daemonHostApplication.ts:33-81`）：撤就绪 → 停监听 → `bootstrap.stop()` →
每个会话 `close('daemon-shutdown')`。会话关闭时 `task-execution` 作业的停止调用 `background.pause()`，无超时地等待全部 driver
（`modules/task-execution/composition/providerBackground.ts:351-357`）；`task-execution-graceful-shutdown`（`services/shutdown.ts:30-71`，
30 秒宽限 + 幸存者标 interrupted）随后运行时已无运行中的任务，且在 PostgreSQL 下作用于进程全局模块（`services/task.ts:391-418`），
不是本 provider 的 `ProviderTaskExecutionModule`。资源复核、托管延迟初始化不在停止范围内。

## 2. 程序

### 2.1 位置

新文件 `cli/daemonLifecycleProgram.ts`，与 RS、H 同层。不放 `bootstrap/`：RFC-376 的部署分支门把 `cli/start.ts` 等入口文件对
`bootstrap/**` 的 import 计为部署分支站点（`T/architecture/rfc294Gates.ts:866-869`）。S2c 把整套底座连同本程序迁入 `bootstrap/`，
届时一并收紧该门的口径（偏离项，见 §7）。

### 2.2 声明

```ts
type DaemonPhase = 'prepare' | 'execution-recovery' | 'post-ready'
type DaemonFailurePolicy = 'fail-closed' | 'best-effort' | 'tracked-detached'

interface DaemonBootStepDeclaration {
  readonly id: string
  readonly phase: DaemonPhase
  readonly failure: DaemonFailurePolicy
  /** 只在一个 provider 上执行时写明原因（§3.2）。 */
  readonly providers?: readonly DatabaseProvider[]
  readonly providerReason?: string
  /** 只在某个部署 profile 下存在（托管附加项）。 */
  readonly profile?: 'crewstation'
}

export const DAEMON_BOOT_STEPS = [ /* §3.1 的顺序 */ ] as const satisfies readonly DaemonBootStepDeclaration[]
export const DAEMON_RUNTIME_JOBS = [ /* §3.4 */ ] as const
export const DAEMON_BACKGROUND_JOBS = [ /* §3.4 */ ] as const
export const DAEMON_CLOSE_PARTICIPANTS = [ /* §3.4 */ ] as const
```

两个 provider 的会话组合函数各构造一份实现记录，交给唯一的构建函数：

```ts
composeDaemonLifecycle({
  provider,
  profile,                       // 'standalone' | 'crewstation'
  steps: Record<DaemonBootStepId, DaemonBootStep | NotApplicable>,
  runtimeJobs: Record<DaemonRuntimeJobId, DaemonProviderRuntimeHandleFactory>,
  backgroundJobs: Record<DaemonBackgroundJobId, DaemonProviderRuntimeHandleFactory>,
  closeParticipants: Record<DaemonCloseParticipantId, DaemonProviderCloseParticipant>,
  profileJobs?: readonly DaemonProviderRuntimeHandleFactory[],   // 只有 crewstation 可给
})
```

- `NotApplicable` 只允许用于声明里带 `providers` 的步骤，且必须与声明一致（运行时校验 + 测试）；其余缺项是类型错误。
- 构建函数按声明顺序产出 RS 的三份列表与步骤序列；`profileJobs` 只能在 `profile === 'crewstation'` 时非空，追加在后台作业末尾。
- 入口根不再出现 `runtimeFactories:` / `backgroundWriterFactories:` / `providerCloseParticipants:` 的手写数组。

### 2.3 执行语义

- `fail-closed`：抛错即终止所在阶段；单机为启动失败，托管 `execution-recovery` 沿用现有处理（冻结执行权并请求退出，
  `bootstrap/executionInitialization.ts:65-70`）。
- `best-effort`：记录带步骤 id 的告警，继续下一步。
- `tracked-detached`：只用于 `post-ready`；不阻塞就绪，Promise 由会话跟踪，会话关闭时在关停预算内等待，超时留下 `abandoned`
  回执。
- 每一步产生回执 `{id, phase, outcome: 'ok' | 'failed' | 'skipped', durationMs, error?}`，进入 `state()` 并写一行
  `lifecycle step` 日志（字段：`id`、`phase`、`outcome`、`durationMs`）。
- **阶段时点**：`prepare` 在会话组合完成后、`executionAuthority.start()` 之前执行；`execution-recovery` 在单机内联执行、在托管
  作为 `initializeExecution` 的工作在激活后执行；`pre-listen` 即 RS 的 `resume`（作业仍各自经 `executionActivationOf` 等待执行权）；
  `post-ready` 在 `serveDaemon` 发布就绪之后启动。
- **会话粒度**：程序按会话运行。迁移切换的目标会话在组合时依次执行 `prepare` 与 `execution-recovery`（与今天 PostgreSQL 组合在
  切换时内联执行启动恢复的时点相同）；进程级步骤（预开恢复、启动租约、迁移）仍在 `startCommand`；PostgreSQL 的待应用恢复留在 provider core 组合之后（§3.2）。进程全局登记在每次 `resume`
  时重新登记，失败回滚到源会话时指回源会话。

## 3. 规范顺序

### 3.1 启动步骤

| # | id | 阶段 | 失败 | 依据（依赖 / 理由） |
| --- | --- | --- | --- | --- |
| 1 | `runtime-declarations` | prepare | fail-closed | 纯检查（`services/runtime/selfCheck.ts:113-124`），与 provider 无关，两个 provider 都执行 |
| 2 | `process-registrations` | prepare | fail-closed | 终态工作区清理策略 + 蒸馏策略提供者；先于任何终态 CAS 与蒸馏入队。此处首次登记，之后每次 `resume` 重新登记（§2.3） |
| 3 | `repository-url-sealing` | prepare | fail-closed | SQLite 独有（`services/repoCredentials.ts:158-330`，旧 SQLite 安装的明文仓库地址修复）；先于技能屏障（S:2750-2751） |
| 4 | `transport-projections` | prepare | fail-closed | 恢复的代码托管探测要用（S:2805-2810）；只执行一次 |
| 5 | `git-credential-lease-cleanup` | prepare | best-effort | 本机文件 |
| 6 | `daemon-identity` | prepare | fail-closed | PostgreSQL 独有（P:859-860）；SQLite 逐次准入（S:3326 等），统一属 S2b |
| 7 | `skill-identity-barrier` | prepare | fail-closed | 先于技能、融合、调度与 HTTP（S:2750-2754） |
| 8 | `fusion-provenance` | prepare | fail-closed | 先于融合决定恢复、融合种子与融合对账（S:2765-2768） |
| 9 | `skill-availability-gate` | prepare | fail-closed | 清空并开启已验证集合，先于复核（`skillBootVerify.ts:53-56`） |
| 10 | `skill-live-files` | prepare | best-effort | 先于复核（S:2944-2946） |
| 11 | `runtime-registry` | prepare | 播种 best-effort、断言 fail-closed | 先于 MCP 运行时测试、续跑、蒸馏（S:3007-3008）；托管下不再与定向续跑竞争 |
| 12 | `event-catalog` | prepare | fail-closed | 事件中心作业与已提交事件消费者需要已登记类型 |
| 13 | `employee-agent-templates` | prepare | fail-closed | 内置工具目录的输入（缺陷修复，§3.3） |
| 14 | `employee-tool-catalog` | prepare | fail-closed | authoring 的输入 |
| 15 | `employee-authoring-ready` | prepare | fail-closed | 结算与员工作业的前提（`authoringService.ts:385-386`） |
| 16 | `employee-writer-state` | prepare | fail-closed | 遗留任务恢复、开发唤醒、员工作业读取写入方状态 |
| 17 | `scheduled-payload-heal` | prepare | best-effort | 先于定时任务循环与 HTTP 定时任务路由 |
| 18 | `fusion-resource-seed` | prepare | best-effort | 幂等 |
| 19 | `demo-seed` | prepare | best-effort | 标记位门控 |
| 20 | `task-execution-recovery` | execution-recovery | fail-closed | 撤销旧 owner、收割孤儿、修租约、清算 effect；RFC-374 的 seq 追平是其第 0 步 |
| 21 | `observation-interrupt` | execution-recovery | fail-closed | 截止时刻之前的调用标为 interrupted，先于任何新调用 |
| 22 | `task-delete-recovery` | execution-recovery | best-effort | 先于续跑 |
| 23 | `archive-recovery` | execution-recovery | best-effort | — |
| 24 | `workspace-maintenance-recovery` | execution-recovery | best-effort | 在孤儿收割之后（S:2852-2853） |
| 25 | `frame-backfill` | execution-recovery | best-effort | 写 node_runs；先于任何任务驱动 |
| 26 | `fusion-decision-recovery` | execution-recovery | best-effort | 假定没有其他写者 |
| 27 | `mr-terminal-reconcile` | execution-recovery | fail-closed | 在孤儿收割之后（缺陷修复，§3.3）；只对账，不装定时器 |
| 28 | `webhook-delivery-recovery` | execution-recovery | fail-closed | 假定没有其他写者；先于 webhook 入站与事件消费 |
| 29 | `legacy-mission-recovery` | execution-recovery | best-effort | SQLite 独有，写入方处于遗留排空时执行（S:4019-4038） |
| 30 | `employee-upgrade-settlement` | execution-recovery | fail-closed | 托管下需要执行权（缺陷修复，§3.3） |
| 31 | `maintenance-boot-snapshot` | execution-recovery | fail-closed | 维护服务的启动意图回合快照（`maintenanceService.ts:357`），在恢复之后、HTTP 准入之前取 |
| 32 | `hosted-targeted-resume` | execution-recovery | fail-closed | 仅 crewstation profile（P:2860-2869），在 21～29 之后 |
| 33 | `resource-reverify` | post-ready | tracked-detached | 在可用集合开启与活文件对账之后 |
| 34 | `bootstrap-admin-hint` | post-ready | best-effort | 只写日志；两个 provider 都执行 |

### 3.2 适用范围

步骤的适用范围保持现状，只有两处扩大：`runtime-declarations` 与 `bootstrap-admin-hint` 都是与 provider 无关的检查或日志，两个
provider 都执行。只在一个 provider 上执行的步骤（3、6、29）在声明里写明原因；统一它们属 S2b。数据库的待应用恢复不进会话程序：它属于打开 provider 的过程，保持今天的位置——SQLite 在打开数据库之前（S:1789-1803），PostgreSQL 在 provider core 组合之后、其余模块组合之前（P:816）；恢复会整体替换库内容，必须先于任何模块组合。

### 3.3 修复的缺陷（PostgreSQL 现行顺序）

| 缺陷 | 现状 | 修复后 | 回归用例 |
| --- | --- | --- | --- |
| MR 终止对账与投递恢复先于收割 | P:1716-1717 早于 P:2707 | 27、28 在 20 之后；托管下在激活之后 | 程序顺序测试；以假步骤记录调用顺序；托管待命实例不执行这两步 |
| 内置工具目录先于模板 | P:1960 早于 P:2833 | 13 → 14 | 全新数据库（双引擎）走完 `prepare` 后，内置工具目录含模板 Agent 的工具 |
| 托管自动升级结算早于执行权 | P:2000 早于 `raw.start()` | 30 在激活之后 | 假执行权：激活前结算未运行，激活后运行 |
| 运行时注册表在写窗口之后、与定向续跑竞争 | S:859 | 11 在 `executionAuthority.start()` 之前 | 托管：`prepare` 完成先于 `start()`；32 在 11 之后 |

另：帧回填（P:1726）移到收割之后；维护 Worker 不再在组合时创建（托管待命实例上创建会因读取围栏抛错再重启）。

### 3.4 作业与收尾顺序

- 运行时作业：`intent-queued-resumption` → `task-execution` → `maintenance` → `mcp-runtime-tests`（不变）。
- 后台作业（统一为 PostgreSQL 现行顺序）：`webhook-terminal-control` → `after-commit-event-pump` → `human-gate-continuation` →
  `committed-event-dispatcher` → `memory-distill` → `development-wake` → `digital-employee-os` → `event-center` →
  `fusion-reconcile` → `resource-limits` → `task-idle-timeout` → `scheduled-backup` → `submodule-refresh` → `batch-import-gc` →
  profile 槽位（crewstation：`hosted-execution-settlement`、`hosted-workspace-command-reconciliation`、`hosted-workspace-lifecycle`）。
- 收尾参与者：不变（§1.1）。`task-execution-graceful-shutdown` 改为作用于本 provider 的模块（§6）。

## 4. 组合无副作用

- **维护服务**：`startMaintenanceService` 拆为构造（被动，不起定时器、不读快照、不创建 Worker）与 `start()`；`maintenance` 作业
  启动时 `start()`。冻结期间 `/api/maintenance/status` 仍可读（它绕过准入，S:600-606），返回未启动状态。启动意图回合快照由步骤 31
  取得后交给 `start()`。SQLite 的晚绑定载荷源（S:3607-3618、S:3792-3793）随构造被动化不再需要 `let` 晚绑定的就去掉。
- **MR 终止控制**：`reconcileOnBoot` 只对账；定时器在 `webhook-terminal-control` 作业启动时装上、停止时卸下。
- **MCP 运行时测试**：两个 provider 都用惰性绑定（今天 PostgreSQL 的 S:942-950 形状），启动恢复在会话恢复时执行，仍在监听之前。
- **事件中心**：`composeEventCenter` 不再 `await initialize()`；登记由步骤 12 执行。
- **authoring**：构造函数不再启动初始化；新增幂等的 `initialize()`（步骤 15 调用），`ready()` 在未初始化时触发同一初始化。SQLite
  HTTP 侧的第二份实例因此在首次 `ready()` 时初始化，不再在构造时分离运行（合并两份实例属 S2b）。
- **内置工具目录**：组合时只建持有者，`load()` 由步骤 14 调用；读者在 `prepare` 完成后才可能被调用。
- **资源复核**：步骤 33。
- 删除 V:2020 的第二次对账。

## 5. 底座扩展（RS / H）

- 作业工厂可选 `dependsOn?: readonly string[]`：只能引用更早声明的作业 id，构建时校验，违反即抛错（不排序、不推断）。
- 作业句柄可选 `ready?: Promise<void>` 与 `health?(): DaemonJobHealth`。H 的轮询适配器（H:116-163）记录
  `{lastRunAt, lastSuccessAt, lastError, consecutiveFailures}`；托管 managed worker 适配器（H:70-93）转出既有的 `health`。
- `state()` 扩为 `{phase, activeHandleIds, jobs: DaemonJobReceipt[], steps: DaemonBootStepReceipt[]}`，作业回执含 `startedAt`、
  `readyAt`、`stoppedAt`、`stopOutcome: 'stopped' | 'timeout' | 'error'`、`stopDurationMs`、`error?`。
- 停止与排空有界：作业可声明 `stopTimeoutMs`（缺省 10 秒；`task-execution` 用 30 秒宽限）。**只在 `daemon-shutdown` 时**超时即
  记 `timeout` 回执并继续下一个；`provider-switch` 与暂停保持今天的无界等待（迁移切换须证明静默）。

## 6. 关停

- `task-execution` 作业在 `daemon-shutdown` 时：暂停模块（既有中止原因）、在 30 秒宽限内等待 driver；超时记 `timeout` 回执。
- `task-execution-graceful-shutdown` 收尾改为接收本 provider 的模块与持久化：SQLite 为进程模块，PostgreSQL 为
  `ProviderTaskExecutionModule`（`modules/task-execution/composition/providerRuntime.ts:513-518`）；它把仍在 running 的任务按
  `services/shutdown.ts` 的既有语义标为 interrupted（`daemon-shutdown-survivor`）。
- 会话关闭时等待 `tracked-detached` 步骤（缺省 10 秒），超时记 `abandoned`。

## 7. 与 RFC-294 目标架构的对齐

| 部分 | 位置 | 层 |
| --- | --- | --- |
| 程序声明与构建 | `cli/daemonLifecycleProgram.ts` | 装配（入口根旁的生命周期底座） |
| 底座字段 | `cli/daemonProviderRuntimeSession.ts`、`cli/daemonProviderRuntimeHandles.ts` | 同上 |
| 组合无副作用 | 各模块 composition / application（维护服务、MR 终止控制、MCP 运行时测试、事件中心、authoring、工具目录） | 原地，最小改动 |

- **偏离项（呈用户确认）**：程序放在 `cli/` 而不是 `bootstrap/`（§2.1）。后继：S2c 把底座与程序整体迁入 `bootstrap/` 并调整
  部署分支门的口径。
- **本 RFC 承担的演进**：S2a 的唯一生命周期程序与 G12 门；组合与生命周期分离。
- **留下的债**：模块重复构造（S2b）；`StartOptions` 与 profile（S2c）；任务执行后台内部私设循环（W9-B）；§3.2 只在一个 provider
  上执行的四个步骤与「同一规则两份实现」（S2b）；托管关停不交还租约（如需改，另立 RFC）。
- 不新增跨 context 内部 import；`architecture/counts.json` 不升。

## 8. 守卫与旧锁

### 8.1 新守卫

`T/architecture/rfc379-daemon-lifecycle-guard.test.ts`（RFC-376 硬门格式：导出纯检测函数、每个检测分支至少一个违规负例、合规
样例、语料下限；登记 `architecture/guard-manifest.json`）：

| 规则 | 报告 |
| --- | --- |
| L1 | 入口根（`cli/start.ts`、`cli/postgresqlDaemonApplication.ts`、`server.ts`、`main.ts`）出现 `runtimeFactories` / `backgroundWriterFactories` / `providerCloseParticipants` 属性或手写的作业 id 数组 |
| L2 | `DAEMON_*` 清单在程序文件之外被重新声明，或清单内 id 重复 |
| L3 | 两个 provider 的会话组合函数中 `composeDaemonLifecycle(` 不是恰好一次 |

G12 的行为层：给两个 provider 完整的假实现记录，构建出的有序 id 清单（步骤、三份作业 / 收尾列表）在单机 profile 下逐项相同；
crewstation profile 只多出 profile 槽位与 `hosted-targeted-resume`。

### 8.2 旧锁处置

| 测试 | 处置 |
| --- | --- |
| `T/rfc359-w3-t15-boot-step-parity.test.ts` | 改写为对程序声明顺序的断言（它是现存最完整的启动顺序说明，§3.1 覆盖其全部标记） |
| `T/rfc359-w3-t14-serve-daemon.test.ts` 的收尾 id 部分 | 改指程序声明 |
| `T/rfc349-sqlite-daemon-pausable-writers.test.ts` | 「每个 id 恰好出现两次」改为程序声明中恰好一次；`:75-88` 失效标记一并删除 |
| `T/memory-distill-timeout-wiring.test.ts` | `id: 'memory-distill'` 计数 2 → 1 |
| `T/rfc338-maintenance-architecture.test.ts` | `startMaintenanceService({` 计数按新形状 |
| `T/rfc349-terminal-control-provider-fence.test.ts`、`T/rfc370-intent-queued-resumption.test.ts` | 「两份列表首项」改为程序声明首项 |
| `T/rfc370-root-background-bindings.test.ts`、`T/rfc359-w3-t4-boot-recovery.test.ts`、`T/rfc359-t7c-task-delete-recovery.test.ts`、`T/rfc359-t7d-postgresql-skill-catalog-boot.test.ts`、`T/rfc223-pr5-boot-restore-wiring.test.ts`、`T/skill-boot-verify.test.ts`、`T/rfc208-boot-and-external-timeouts.test.ts`、`T/rfc359-w12-daemon-bootstrap-composition.test.ts` | 按根文件 `indexOf` 比顺序的部分改指程序声明；行为部分不动 |
| `T/architecture/rfc359-w5-t19c-startup-sequence.test.ts`、`T/architecture/rfc359-w5-unattended-void-promise.test.ts` | 计数随站点变化更新 |
| `T/architecture/rfc376-structural-guards.test.ts` 的 `direct-setinterval-sites` 等基线 | 删除的站点按 `architecture:report --gates` 重算（只减） |
| `T/rfc349-shutdown-seal-then-close.test.ts` | 夹具假定「宽限关停先于会话关闭」，按 §6 的真实顺序改写 |

其余按文本锁定根文件某段装配的测试（研究清单约 119 个）只在本 RFC 移动了它们锁定的片段时才改，改法是改指新位置，不放宽断言。

## 9. 测试策略

用 `describeEachProvider`（本地 `AW_TEST_PROVIDERS=sqlite`，CI Ubuntu 双引擎）。

1. 程序单测：§3.1 的顺序、`NotApplicable` 只能用于声明了 `providers` 的步骤、三种失败策略、回执、阶段时点（以假执行权证明
   `prepare` 先于 `start()`、`execution-recovery` 在 `whenActive` 之后、待命实例不执行 `execution-recovery`）、会话粒度（切换目标
   会话执行一次、全局登记随 `resume` 重做）。
2. G12：两个 provider 的完整假记录 → 有序 id 清单相同；crewstation profile 的差异只在声明的位置。
3. 底座：`dependsOn` 校验、就绪、轮询健康、`daemon-shutdown` 有界停止与 timeout 回执、`provider-switch` 保持无界。
4. 组合无副作用：组合后、`resume` 前维护服务无定时器、无 Worker（计数 / 假定时器），MR 终止定时器未装，authoring 未初始化。
5. §3.3 每个缺陷的回归用例（见表）。
6. 关停：不响应中止的假 driver → 关停在宽限后继续，任务标为 interrupted；收尾作用于本 provider 模块（两个 provider 各一）。
7. 真实守护进程：扩展 `T/daemon-start.test.ts`，断言 `lifecycle step` 日志按 §3.1 顺序出现；PostgreSQL 的同一断言落在
   `T/rfc370-v3-hosted-standby-boot.integration.test.ts`（CI 上真实启动 PostgreSQL 守护进程：待命期间 prepare 全部按序、
   恢复阶段不执行，激活后恢复阶段按序）。单机 PostgreSQL 需经一键迁移建立数据库代指针，不放进每次提交都跑的用例。
8. 新守卫 §8.1 与 `T/architecture` 全目录；§8.2 的旧锁改写。
9. 既有行为套件不改即通过：启动恢复、MR 终止控制、维护服务、MCP 运行时测试、事件中心、数字员工、托管执行权的现有用例。
