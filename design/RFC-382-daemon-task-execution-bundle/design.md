# RFC-382 设计：任务执行模块组

研究基线 HEAD `682d55904` 加 RFC-381 工作树（研究期间 S、V、P 仍在被改动，行号可能偏差约 ±2，以实施时源码为准）。

- `S:` = `packages/backend/src/cli/start.ts`
- `V:` = `server.ts`
- `P:` = `cli/postgresqlDaemonApplication.ts`
- `TE/` = `modules/task-execution/`
- `T/` = `packages/backend/tests/`
- 其余路径相对 `packages/backend/src/`

## 1. 现状

### 1.1 会话级驱动协调器

`DefaultTaskDriveCoordinator`（`TE/application/drive/taskDriveCoordinator.ts`）只持有冻结的选项，每次 `submit` 新建一个 `AbortController`。
可变状态都在端口后面：执行模块的运行注册表与认领闸门、心跳表、仓库准备的进行中表。所以多个实例本身不改变行为，**改变行为的是各实例的配置不同**。

| # | 位置 | 生产可达 | 配置 | 消费者 |
| --- | --- | --- | --- | --- |
| C1 | S:2555-2647 `routeLaunchDriveCoordinator`（`createTaskDriveCoordinator`，`services/task.ts:1241`） | 是 | 本地同步；每次提交重读配置文件；带提炼入队器；无子 Agent 实时捕获；延后仓库准备（克隆超时、基线窗口为组合时值）；默认带门控续跑前置步骤；引擎异常被吞（`services/task.ts:1340-1357`） | provider 的 `routeLaunch`（Agent / 工作组启动，经 V 的 `taskRouteLaunch` 供 HTTP 与 MCP）、`launches`（Webhook / 事件、定时触发） |
| C2 | S:2796-2836，在 `hostActionEnvironment`（S:2753-2854）内 | 是 | `buildStartTaskDeps` 组合时快照（子 Agent 实时捕获为启动时值）；无仓库准备；无提炼 | 开发自动化的 Agent / 脚本执行器、数字员工 OS 的反应执行 |
| C3 | V:2761-2808 | 是 | 选择模式（V 自建 `composeTaskLaunchConfiguration`，V:1722-1727）；实时捕获；无提炼；V 自己的持久化 | V 的 HTTP 侧数字员工反应执行 |
| C4 | V:2946-3035 | 是 | 选择模式；带提炼与实时捕获；延后仓库准备（不带选择的效果） | `POST /api/tasks`（JSON、multipart 与对应 MCP）、定时任务「立即运行」 |
| C5 | V:1544-1585 | 仅测试 | — | `composeFallbackDevelopmentAutomation` |
| C6 | P:1180-1257 `boundTaskDriveCoordinator` | 是 | 单机 `currentRunConfig()`（P:1041-1047）、托管 `selectedRunConfig()`（P:1048-1058，带实时捕获）；无提炼；**无门控续跑前置步骤**；引擎异常经失败上报（P:1218-1231） | provider 的路由启动全部、仓库准备重试、`taskLaunchKernel`（P:1496，供数字员工与开发自动化）、人工门续跑驱动（P:2437-2440） |

每次调用现建的协调器（`services/task.ts` 的 `startTaskImpl` / `wakeHumanGateContinuation` / `retryRepoPreparation`，
`TE/infrastructure/childExecutionLaunchOperations.ts:380-425`、`childTaskLifecycleParticipant.ts:1129-1191`、
`postgresqlFusionEngineTaskOperations.ts:352-414`）不在本 RFC 范围（RFC-385）。

### 1.2 provider 运行时

定义在 `TE/composition/providerRuntime.ts`：SQLite 的在 `:279-433`，由 S:2360-2545 调用；PostgreSQL 的在 `:504-705`，由 P:1060-1168 调用。
两者约 85% 相同。

真正按 provider 不同的部分：

- 执行模块与认领：SQLite 用进程单例 `taskExecutionModule` 的 `claim({db, intentId})`；PostgreSQL 用会话模块的 `claimPersisted`。
- 进程并发作用域对象：SQLite 是数据库客户端，PostgreSQL 是 PG runtime 对象。它的同一性必须与配置热应用的作用域一致。
- 融合引擎适配器。
- 仓库准备重试命令。

只有 PostgreSQL 有的成员：`routeLaunch.workflow` 根工作流启动内核（`:692-695`）、`workgroupTaskRoom` 工厂。
P 在 P:1172 又建了一次驱动生命周期端口，输入与 `:543-550` 相同。

### 1.3 V 在 SQLite 生产中重复构造的成员

S 已经构造了同样的东西，V 又另建了一份，全部在生产中生效：

- 持久化（V:1854）。
- 任务路由操作（V:2491-2628），以及它自带的子任务生命周期参与者、生命周期端口、活动 / 停止注册表、修复参与者、重试命令。
  与 provider 运行时用的是同一工厂 `createTaskRouteOperations`，只是输入不同。
- C3、C4。
- 启动参与者（V:3040、V:3099）。
- 定时启动（V:3095）。
- 概览（V:3086）。
- 澄清指令路由（V:3243）。
- 房间工厂与房间续跑（V:3043-3057）。
- 任务目录来源（V:2874，SQLite 唯一一份）。
- Agent / 工作组启动资源（V:2893、V:2942）。
- 仓库准备组合（V:2922、V:3020）。

只在测试中可达的：资源绑定 V:898-912、运行时回退 V:1864-1933、`deps.taskRouteLaunch ??` 回退 V:3038、归档回退 V:3384。

无人读取：`taskExecutionLaunches`（V:3523）。

另外，S 的 provider 成员 `lifecycleProjector`、`overview`、`routes.clarifyDirective` 在 SQLite 上无人消费，S 另建了投影器（S:2961）。

**测试缺口**：双引擎 HTTP 测试夹具经 V 的 `composeSqliteApplicationDeps` 组 SQLite（`T/helpers/providerHttpApplication.ts:210-217`），
因此 S 独有的生产路径（C1、C2、S 的续跑运行时）不被双引擎 HTTP 测试覆盖。本 RFC 之后 V 的回退调用同一构造函数，缺口随之消失。

## 2. 行为统一

### 2.1 唯一实时运行配置（取舍 2）

会话组合给出：

```
runConfiguration() = {
  appHome, configPath, subagentLiveCapture?,
  ...runtimeConfigOpts({ ...await taskLaunchConfiguration.start(), memoryDistillEnqueuer }),
}
```

形状参照 `cli/daemonModules/fusion.ts` 的 `runConfiguration()`。克隆超时与基线同步窗口也从同一来源每次读取。

使用这一份配置的地方：

- 会话协调器的 `runtime` getter；
- 两个 provider 的 `rootResumeRuntime`：修复 S:2490-2513 本地同步分支把 `resolveLaunchRuntimeConfig` 原样展开的缺陷，并删除
  P:1041-1058 的 `currentRunConfig` / `selectedRunConfig` 两份；
- 宿主任务（经根工作流启动内核，§2.5）；
- 延后仓库准备。

`T/rfc103-launch-config-passthrough.test.ts:204-208` 锁住的正是原样展开的形状，改为断言经过投影，并说明原因。

### 2.2 门控续跑前置步骤（取舍 3）

会话协调器在两个 provider 上都带 `composeGateContinuationPreDrive({ db, memoryDistillEnqueuer })`：即 `services/task.ts:1333-1338`
的默认值，C6 没有这一项。

先写双引擎用例确认修复前的行为：在评审回退或澄清回答之后，经人工门续跑驱动提交续跑，断言收敛与工作区回退效果在驱动前执行。

- 若 PostgreSQL 修复前确实缺失，加上该步骤即修复。
- 若用例显示 PostgreSQL 已在别处执行，则不重复加，记录依据，并更正
  `modules/collaboration/infrastructure/clarifyContinuationConvergence.ts:15-17` 的注释。

### 2.3 引擎异常（取舍 4）

会话协调器的引擎编排不再吞异常：`schedulerDriver.drive` 抛出的异常交给失败上报，任务置为 `failed`
（`errorSummary: 'task drive failed'`），意图以 `task-drive-failed` 终结并带认领世代，即 P:1218-1231 的形状。

本 RFC 只改会话协调器；`createTaskDriveCoordinator` 的其他调用方（每次调用的协调器）不变，属 RFC-385。

### 2.4 PostgreSQL 会话的运行注册表

S 的 PostgreSQL 会话组合中，以下两处改读本会话执行模块（经模块组输出的 `activeTaskIds()` / `isTaskActive()`）：

- 维护载荷 `activeTaskIds`（S:825，现为进程级 `activeTaskIdsSnapshot`）；
- `nudgeWorkspacePrune` 的运行中守卫（S:940，现为进程级 `isTaskActive`）。

SQLite 一侧语义不变：进程单例就是会话模块。`testActiveControllers` 测试钩子保留在 legacy 包装中。

### 2.5 宿主任务的启动内核（取舍 5）

SQLite 的 provider 运行时补出与 PostgreSQL 相同的 `routeLaunch.workflow`（`TE/composition/providerRuntime.ts:692-695` 的形状），
由会话协调器驱动。

- S 的 `hostActionEnvironment` 改用它，删除 C2 及其专用内核（S:2776-2835）。
- V 的 HTTP 侧数字员工改用注入的同一内核，删除 C3。数字员工模块本身的去重属 RFC-383。
- 宿主任务的身份解析（S 每次调用准入守护身份、P 启动时准入一次）与取消（S 每次调用新建 `composeTaskCancellation(db)`）
  本 RFC 保持现状，由 RFC-383 统一。

宿主任务借用工作区，延后仓库准备不改变行为（`TE/infrastructure/taskRouteLaunchOperations.ts` 借用工作区分支）。

### 2.6 动态工作流校验（取舍 6）

`modules/resource-catalog/composition/workflowOperations.ts:215-221` 的 `composeSqliteDynamicWorkflowValidationContext(db)` 已与 provider
无关（读库 + 候选闭包），改名为中立名称，两个 provider 共用。删除 P:990-1006 以系统身份列目录的实现。

先写双引擎用例：动态工作流引用内置 Agent，确认修复前 PostgreSQL 是否误拒。

### 2.7 消费方从 V 改到注入实例

V 改为消费模块组：

- 任务路由操作：provider 的 `routes.tasks`。
- 启动参与者、定时启动：provider 的 `launches` 与 `trigger`。
- 概览、澄清指令路由：provider 成员。
- 工作组房间：provider 的 `workgroupTaskRoom`，SQLite 也补出这一成员。
- 任务目录来源、资源绑定、持久化：模块组成员。

S 也改用 provider 的 `lifecycleProjector`，删除自建的投影器。

V 自建路由操作与 provider 路由操作之间的**每一处输入差异**都要在实施报告中逐项列出，并说明在本 RFC 中如何消解：

- 由 §2.1 统一的，注明；
- 无法消解的，作为偏离项列出，不得静默改变行为。

房间续跑：SQLite 现在在请求内驱动（`services/task.ts:3211-3264`），PostgreSQL 只做预检、交给 worker（P:1359-1372）。
本 RFC 保持各自现状，由 provider 的房间成员按适配器给出；统一属 RFC-385。

## 3. 构造函数

| 文件 | 内容 |
| --- | --- |
| `cli/daemonModules/taskExecution.ts` | `composeDaemonTaskExecutionModules(input)` |
| `cli/daemonModules/adapters.ts` | `DAEMON_TASK_EXECUTION_ADAPTERS`，形如 `DAEMON_PROVIDER_CORE_ADAPTERS`，`satisfies Record<DatabaseProvider, …>` |

**适配器条目**：

- provider 运行时组合函数：现有两个函数保留，由条目把中立输入映射到各自参数，函数合一属 RFC-385；
- 执行模块与认领；
- 进程并发作用域；
- 融合引擎适配器；
- 仓库准备重试命令。

**输入**：现有两个根传给 provider 运行时与协调器的全部依赖的并集，按来源分组：

- 会话：`db`、`appHome`、`configPath`、`secretBox`、`taskLaunchConfiguration`、守护世代；
- 选择项（StartOptions 的执行相关项）；
- provider 核心；
- 观测组；
- 资源目录组；
- 仓库凭据组；
- 记忆组（含提炼命令）；
- 惰性工作区收尾；
- 告警广播；
- 测试接缝：调度驱动覆盖，仅 V 回退使用。

**输出**（冻结）：

- 资源绑定与快照；
- 持久化；
- provider 运行时全部成员：两边都暴露 `routeLaunch.workflow`、`workgroupTaskRoom`、`collaboration`；
- 会话协调器；
- `runConfiguration()`；
- 任务目录来源；
- `activeTaskIds()` / `isTaskActive()`。

**约束**：

- 构造无 SQL、无定时器；后台作业与启动步骤仍归 RFC-379 的生命周期程序。
- 惰性回边保持为闭包：记忆 → 协作上下文、工作区收尾、融合运行配置。
- 模块组内的构造顺序：持久化 → 模块 → 生命周期端口 → 参与者 → 运行时 → 协调器 → 路由启动。

**调用顺序**：在两个会话组合中，位于 RFC-380 各组之后，工作区维护、定时任务组、融合组、集成组之前。

其余规则同 RFC-380 design §2、§6：命名不含 provider 名、加入 `BOOTSTRAP_FILES`、R1 账本双向精确、不 import `bootstrap/`、
不比较 provider 名、`backend-value-scc` 为 0、无占位持有者、不 import identity-access（RFC-381 守卫）。

新增的值依赖经 task-execution 的 `composition/*` 入口。缺 composition 再导出的（如 `createTaskExecutionResourceBinding`、
`createTaskDriverLifecyclePort`）补出，用以清偿根到 task-execution 内部的 R1 条目。

## 4. server.ts

`AppDeps` 增加 `taskExecutionModules`。

- V 中 §1.3 的生产重复构造改用注入实例，回退调用同一构造函数，测试的调度驱动覆盖经测试接缝传入。
- 删除无人读取的 `taskExecutionLaunches`。
- `RuntimeComposedAppDeps` 中由模块组提供的字段改为必填。

## 5. 测试策略

1. **构造函数单测**：成员齐全、冻结；构造无 SQL、无定时器；两个会话互不共享有状态成员。
2. **结构锁**：扩展 `T/architecture/rfc380-daemon-module-bundles.test.ts`。
   - S、P 各调用一次；V 只在回退中调用。
   - 三个入口根中不出现 `createTaskDriveCoordinator(`、`new DefaultTaskDriveCoordinator(`。
   - 底层工厂不在根中直接调用。
3. **双引擎回归**（经真实 provider 数据库与模块组）：
   - 续跑沿用设置：组合后修改提交推送与合并 Agent 设置，自动续跑与生命周期修复续跑的调度请求带新值。
     两个 provider、两种配置模式都测，修复前 SQLite 本地同步模式失败。
   - 提炼入队器：会话协调器、根续跑与宿主任务的调度请求都带执行结束提炼观察者。
   - 门控续跑前置步骤：见 §2.2。
   - 引擎异常：调度驱动抛出，任务置为 `failed`、意图以 `task-drive-failed` 终结（修复前 SQLite 停在运行中）。
   - PostgreSQL 会话的活跃任务：运行中的 PostgreSQL 驱动出现在维护载荷中，工作区清理守卫跳过它。
   - 动态工作流引用内置 Agent：见 §2.6。
   - 子 Agent 实时捕获、克隆超时、基线窗口：组合后修改，下一次启动生效。
4. **SQLite 单实例**：V 使用注入的路由操作、启动参与者、协调器（以同一性断言）；HTTP 启动与 MCP 启动经同一会话协调器。
5. **旧锁改指，不放宽意图**：
   - `T/rfc319-cfg45-default-runtime-hot-read.test.ts` 的协调器站点计数与 RFC-381 切片；
   - `T/rfc359-w5hn-drive-coordinator-runtime-config.test.ts`；
   - `T/rfc103-launch-config-passthrough.test.ts`；
   - `T/rfc339-wrapper-runtime-cutover.test.ts:381-382`；
   - `T/rfc359-w4-d27-adapters.test.ts:235-237`；
   - `T/rfc359-t3-action-execution-runners.test.ts:513-575`；
   - `T/rfc349-rest-launch-ownership.test.ts:119-131`；
   - `T/architecture/rfc359-w5-t19b-composition-root-complete.test.ts`；
   - `T/architecture/rfc359-w5-same-file-provider-pairs.test.ts`；
   - `T/architecture/rfc376-structural-guards.test.ts` 与 `T/architecture/rfc294-review-offered-edge-dag.test.ts` 中 `providerRuntime.ts` 的出边；
   - 以及实施时发现的其他锁。

   逐条在报告中说明新旧断言。
6. **既有套件不改即通过**：除上述锁与因 §4 行为变化而更新的断言外。

## 6. 与 RFC-294 目标架构的对齐

本 RFC 是 S2b 第三批。

完成的演进：

- 任务执行组每会话一份；
- 会话级驱动协调器每会话一个；
- SQLite HTTP 的任务执行成员不再自建。

偏离项同 RFC-380：`cli/daemonModules/` 暂放。

留下的债：

- 每次调用现建的协调器改经工厂端口、两个 provider 运行时函数合一、门控续跑唤醒 / 房间续跑 / 仓库准备重试 / 融合适配器的语义统一：RFC-385。
  届时 `DefaultTaskDriveCoordinator` 只在装配层构造，满足 S2b 退出门。
- 数字员工与开发自动化：RFC-383。
- 意图：RFC-384。
- SQLite HTTP 挂载表与测试回退：RFC-386。
- 待单独核实：PostgreSQL 的执行世代取数据库世代（`input.provider.runtime.generationId`，跨重启稳定），而 SQLite 取进程级
  `DAEMON_GENERATION`。启动恢复只撤销世代不同的认领（`TE/infrastructure/taskExecutionRecovery.ts:84-106`），因此 PostgreSQL 重启后，
  前代认领只能等 60 秒租约到期。托管下这可能是有意的（无法证明旧进程已退出），需与托管语义一并核实后另行处理，本 RFC 不改。
