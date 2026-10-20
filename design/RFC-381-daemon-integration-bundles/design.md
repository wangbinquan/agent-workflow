# RFC-381 设计：集成、定时任务与融合模块组

研究基线 HEAD `d8bb1a672`（RFC-380 提交后行号移动，以实施时源码为准）。`S:` = `packages/backend/src/cli/start.ts`，`V:` = `server.ts`，
`P:` = `cli/postgresqlDaemonApplication.ts`，`T/` = `packages/backend/tests/`；其余路径相对 `packages/backend/src/`。

## 1. 现状

### 1.1 集成

| 项 | S（SQLite 会话） | V（SQLite HTTP） | P |
| --- | --- | --- | --- |
| MR 终止控制（有状态：启动监督器、恢复后装定时器） | 2908-2918，清理函数 `finishClaimedWebhookWorkspacePrune` | 不构造（用 S 注入的实例） | 1667-1676，清理函数 `workspaceMaintenance.finalizeClaimedWorkspace` |
| 投递持久化 | 2919 | — | 1679、2805 |
| 分发器（按流串行队列） | 2945-2954（`composeWebhookDispatchCore`） | 不构造 | 1677-1689（四个构造函数逐一写出，同一实现） |
| 端点服务 / 触发器服务 / 投递运行时 | — | 3757-3768 实际在用（触发器服务基于 V 自己的定时任务运行时） | 1761-1765、1748-1751、1666 |
| 入站持久化 | — | 2339-2340（`??` 回退，S 从不注入，故实际构造） | 2329 |
| 事件自动化（存储、委托上下文绑定、任务 / 员工 work-start） | 2928-2944 | 2500-2524 **无人使用** | 1649-1665 |
| 事件中心（每实例一个租约 workerId） | 3164-3203（5 个类型包，消费者无条件） | 1884-1947 回退（4 个类型包，消费者按能力门控）；3324-3333 **不可达** | 1701-1747（5 个，按能力门控） |
| 审批网关 / 开发工具连接（无状态） | 2955-2958 / 3839 | 3300-3303 / 3360 **重复** | 1696-1699 / 1915 |

### 1.2 定时任务

`composeScheduledTaskRuntimeFor`：S:2713-2735（`assertWorkflowLaunchable: (w) => assertWorkflowSnapshotLaunchable(db, w)`，即
`services/taskLaunchGate.ts:49-71`）、V:3712-3721（同上，重复）、P:1613-1631（内联校验：系统身份的目录列表，不识别被校验工作流，
`ConflictError` 409，只取第一条错误）。保存路径：`routes/scheduledTasks.ts`、`services/webhookTriggers.ts`、MCP `resource_write`；后台：
定时 ticker、事件中心 → Webhook 分发准入。错误映射见 `util/errors.ts:143-185`。

### 1.3 融合

| 项 | S | V | P |
| --- | --- | --- | --- |
| 融合运营 | 2742-2754（只用于对账与启动步骤，不启动任务） | 3966-4004 **重复**，承担全部启动（`POST /api/fusions`、`/reject`） | 1558-1569 |
| 引擎任务适配器的启动设置 | `fusionStartDeps`（S:2415-2432）：local-sync 快照 | `selected` 实时读取（`services/task.ts:1763-1770`） | 只在托管（selected）时传 `runConfiguration`（P:1383-1391）；单机不传 |

路由每次请求自己解析 4 项设置（`fusionRoutes.ts:66-82`）；其余启动设置（合并 Agent、并发池、子 Agent 实时捕获等）取决于适配器。

## 2. 四处差异的处置

### 2.1 融合启动设置（取舍 1）

共享融合栈以会话的启动配置为实时来源：SQLite 引擎适配器的 `startDeps.launchConfiguration` 用 `taskLaunchConfiguration.continuationQueries`
（两种模式都实时；先例 S:3209）；PostgreSQL 适配器始终传 `runConfiguration: async () => 投影(await taskLaunchConfiguration.start())`
（与 P 现有的 selected 形状相同，`drive()` 换为 `start()` 以带上子 Agent 实时捕获）。路由的 `launchConfiguration` 用同一实时来源。
`T/rfc319-cfg45-default-runtime-hot-read.test.ts` 扩到融合路径。

### 2.2 工作区清理（取舍 2）与运行注册表（取舍 3）

- 两个 provider 的 `composeTaskSourceTermination` 都用会话的 `composeWorkspaceMaintenanceCommand(...)` 实例的 `finalizeClaimedWorkspace`，
  包一层：失败记 `warn` 并保留认领，不抛给 MR 终止作业。SQLite 专属的 `finishClaimedWebhookWorkspacePrune` 失去该调用方（启动恢复
  与维护 Worker 已在用通用命令）；若再无调用方则删除。
- 源终止参与者接收 `taskExecutionProvider.executionModule.runtimeRegistry`（SQLite 上即进程模块，行为不变；PostgreSQL 上找到私有注册表里
  的驱动令牌，`requestStop` 后等待停止，回执 `released`）。两项同一提交落地。

### 2.3 定时任务校验（取舍 4）

一份 `composeScheduledTaskRuntimeFor`（`cli/daemonModules/scheduledTasks.ts`），`assertWorkflowLaunchable` 用
`assertWorkflowSnapshotLaunchable(db, w)`；P 删除内联校验，`validationContext` 仍供动态工作流使用。可选的进一步收敛（与启动路径
`agentLaunchResources.validateHostWorkflow` 共用）留作后续，不在本 RFC。

### 2.4 事件中心（取舍 5）

一份构造：5 个类型包，消费者按能力门控（P 的写法），`beforeObservationWrite` 与 CrewStation 事件经托管选择注入；初始化仍由
RFC-379 的 `event-catalog` 步骤显式执行。

## 3. 构造函数

| 文件 | 函数 | 要点 |
| --- | --- | --- |
| `cli/daemonModules/scheduledTasks.ts` | `composeDaemonScheduledTaskModules` | 定时任务运行时 + 资源快照工厂；统一校验 |
| `cli/daemonModules/integration.ts` | `composeDaemonIntegrationModules` | §1.1 全部成员；MR 终止的清理函数与运行注册表按 §2.2；员工 work-start 为调用方给的惰性端口；托管选择（`beforeEventObservationWrite`、`crewStationEvents`）与测试接缝（分发器覆盖）由 P 经适配器传入 |
| `cli/daemonModules/fusion.ts` | `composeDaemonFusionModules` | 融合运营 + 按 §2.1 的实时启动来源；`tasks` 为 provider 运行时给出的融合适配器 |

调用顺序：定时任务组在任务执行 provider 运行时之后；集成组在工作区维护命令、任务执行 provider、定时任务组之后，在开发自动化、
已提交事件分发器、`composeSqliteAppDeps` 与数字员工之前；融合组在 provider 运行时之后。所有函数构造无副作用（RFC-379）；
MR 终止控制的启停、事件中心初始化仍归生命周期程序。规则同 RFC-380 design §2、§6（命名、`BOOTSTRAP_FILES`、R1 账本、
不 import `bootstrap/`、不比较 provider 名、`backend-value-scc` 为 0、无占位持有者）。

## 4. server.ts

`AppDeps` 增加三组的注入字段；V 中 §1 列出的重复构造改用注入实例，回退调用同一函数；删除无人使用的事件自动化实例
（V:2500-2524）与不可达的事件中心回退（V:3324-3333）。

## 5. 测试策略

1. 构造函数单测：成员齐全、冻结、构造无 SQL / 无定时器。
2. 结构锁（扩展 `T/architecture/rfc380-daemon-module-bundles.test.ts` 或新增同格式守卫）：S、P 各调用三组恰好一次；V 只在回退中调用；
   底层工厂不在根中直接调用。
3. 双引擎回归：
   - PostgreSQL 上 MR 关闭时运行中的 Webhook 任务经 `requestStop` 立即停止（修复前驱动继续运行，回执经心跳后才收尾）；
   - 工作区清理失败：MR 终止作业成功、认领保留、同流后续处理不被阻塞；
   - 定时任务与 Webhook 触发器保存：不可启动的工作流两边都是 422 `workflow-invalid`，子工作流接线问题在保存时拒绝，内置 Agent 引用
     不被误拒；Webhook 投递遇不可启动工作流为 `launch-failed` 并更新触发器卡片；
   - 融合：组合之后修改的启动设置在下一次融合启动生效（两边）。
4. 受影响的旧锁改指（例如 `T/rfc317-work-start-bind.test.ts` 的分发器与 work-start 顺序锚点、`T/rfc359-w3-t15-boot-step-parity.test.ts`
   保持根中的局部名），不放宽意图。
5. 既有套件不改即通过（除上述锁与因 §4 变化而更新的 PostgreSQL 断言）。

## 6. 与 RFC-294 目标架构的对齐

S2b 第二批；偏离项同 RFC-380（`cli/daemonModules/` 暂放）；留下的债：RFC-382、RFC-383、S2c。
