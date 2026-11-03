# RFC-434 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`M` = `S/modules`。以 RFC-433 收尾后的源码（`43fcce84c`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：integration、memory、task-execution、development-automation 的 `public/` 精确入口与 `application/ports`；
  入站路由（`routes/`）与一个 legacy 服务只改导入。
- **承担的演进**：W4 B / D 第一步。public 入口全部精确，第一批 8 条模块外深引改走精确入口。
- **不新增**跨 context 依赖、facade 与转发文件；不新增 `routes/` / `services/` 耦合。

## 1. 非精确 public 文件并入精确入口

| 原文件                                   | 符号 → 去向                                                                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M/integration/public/mrTerminalControl` | `ProtectedMrLaunchGuardInput`、`ProtectedMrLaunchGuard`、`MrTerminalControl` → `participants`                                                                                                                                                              |
| `M/memory/public/catalog`                | `MemoryWithChain`、`PatchMemoryResult`、`MoveMemoryResult`、`MemoryScopeRef`、`FusedIntoSkillMemory` → `types`；`MemoryScopeAuthority`、`MemoryCatalogQueries` → `queries`；`MemoryCatalogCommands` → `commands`；`MemoryCatalogOperations` → `operations` |
| `M/task-execution/public/taskRoutes`     | `TaskRouteListFilters`、`TaskRouteLifecycleAlertNotice`、`TaskRouteDeleteResult` → `types`；`TaskRouteOperations` → `commands`（经 `./types` 引用 `NodeRunPromptOperations`、`TaskArchivedEventsReader`）                                                  |

- 符号原样搬入，不改名；精确入口里没有同名导出。生产与用例的导入方全部改为新入口，原文件删除。
- 三条既有规则决定了去向：
  - `MemoryScopeAuthority` 含 `RequestAuthority`，能力归属规则（`rfc294Gates.ts` 的 `capabilityForgeViolations`）只允许它出现在 `types` / `events`
    之外，所以放在使用它的 `queries` 旁；
  - `TaskRouteOperations` 若放进 `types` 就得直接 import `@/platform/background/eventsArchiveContent`，被 public surface 规则判为禁用导入；
    放在 `commands` 经 `./types` 的 public 再导出引用，与原文件的做法一致；
  - `TaskRouteOperations` 原有的函数类型债随之移到 `public/commands`（同一条债，换位置登记）。

## 2. 第一批路由去深引

| 调用方                                | 原深引                                                                         | 改为                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `routes/tasks.ts`                     | `task-execution/application/ports/taskRecoveryOperations`、`public/taskRoutes` | `public/participants`（已导出 `TaskRecoveryOperations`）、`public/commands` / `types`（§1）                           |
| `routes/taskArchive.ts`               | `task-execution/composition/taskArchiveMaintenance`（只转出类型）              | `task-execution/public/commands` 导出 `TaskArchiveMaintenanceCommand`（定义在 `application/ports`）                   |
| `routes/missionInputUploads.ts`       | `development-automation/application/missionInputUploadOperations`              | `development-automation/public/commands` 导出 `MissionInputUploadOperations`                                          |
| `routes/webhooks.ts`                  | `integration/composition/webhookIngress`                                       | `WebhookIngressPersistence` 搬到 `integration/application/ports/webhookIngressPersistence`，由 `public/commands` 导出 |
| `routes/webhookDeliveries.ts`         | `integration/public/mrTerminalControl`                                         | `integration/public/participants`（§1）                                                                               |
| `services/webhook/webhookDispatch.ts` | 同上                                                                           | 同上                                                                                                                  |
| `routes/memories.ts`                  | `memory/public/catalog`                                                        | memory 的 `operations` / `queries` / `types`（§1）                                                                    |

- `WebhookIngressPersistence.endpoints` 改为 `WebhookIngressEndpointReads`（`get`、`getByUrlToken` 两个读方法）。原先 `Pick` 整个
  `WebhookEndpointAdministrationPort`，public surface 走查会进入管理端口、带出其补丁类型里的 `Partial`；管理端口在结构上满足收窄后的接口。
- `WebhookDeliveryRuntime` 留在 composition（扩展 application 里的 `WebhookIngressPersistence`），因为它的投递查询带遗留 `Actor`，见 §3。
- composition 文件改为从 `application/ports` 导入，组合函数不变；装配层不改。

## 3. 留给下一步的路由深引

- `routes/digitalEmployees.ts`：数字员工模块句柄的视图类型在 composition，`ToolConnectionVisibilitySubject` 在 `composition/required-ports`，
  `DigitalEmployeeMigrationStatus` 在 `composition/writerCutover`。
- `routes/eventCenter.ts`、`routes/webhookDeliveries.ts`：事件中心句柄内联在 composition，自定义来源与响应规则的类型是 `ReturnType<…>` 推断；
  另外 Webhook 投递运行时的查询带遗留 `Actor`。
- `routes/code.ts` 与 `routes/capabilityTemplates.ts`：stage 合同纯函数的类型含 `ZodType`。code-capability/public/queries 已有一份刻意分离、
  由 `rfc307-stage-graph` 钉住的投影类型。能力模板与上游操作的签名带遗留 `Actor`，属 E8。
- `routes/taskCatalog.ts`：任务目录查询带遗留 `Actor` 且返回 JSON 字符串，属 E10。
- `routes/scheduledTasks.ts`：运行时由 `services/scheduledTasks` 的类型组成，需随 integration 迁移。

## 4. 账本与计数（实测）

| 账本                                                                                | 变化                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `architecture/commons-debt.json` `R1-inbound-module-internals`                      | 210 → 202，删 G2 的 8 条                                     |
| `T/architecture/rfc317-module-boundary.test.ts` `NON_EXACT_PUBLIC`                  | 3 → 0                                                        |
| `T/rfc294-architecture-preflight.test.ts` `CROSS_CONTEXT_INTERNAL_DEBT`             | 删 8 条指向非精确 public 文件的边                            |
| `T/rfc294-architecture-preflight.test.ts` `PUBLIC_SURFACE_DEBT`                     | 删 3 条 non-exact 与 1 条旧位置的函数类型债，新位置登记 1 条 |
| `T/architecture/rfc376-structural-guards.test.ts` 跨 context 内部边 / `counts.json` | 56 → 48                                                      |
| `T/architecture/rfc376-structural-guards.test.ts` DAG 外 offered 边 / `counts.json` | 54 → 55（2 条依赖重新归类，见 proposal §6 第 6 条）          |
| `T/architecture/rfc294-review-offered-edge-dag.test.ts`                             | 登记同样 2 条，写明理由与清偿波次                            |
| `T/rfc305-architecture-lock.test.ts`                                                | identity-access 的消费者路径随 §1 更新                       |
| guard-manifest                                                                      | 刷新改动过的锁的行数                                         |

## 5. 失败模式

- 并入时漏改导入方：typecheck 报出。
- public 意外 re-export composition，或带出遗留 `Actor`、能力类型、开放类型：对应结构规则精确比对，增加即红。
- 账本漏改或误增：账本测试按精确清单比对。

## 6. 测试策略

- 无新增行为用例：类型与导入路径调整不改变运行时对象。
- **回归**：
  - typecheck；
  - 全部架构测试：账本、计数、public surface、跨 context 边、能力归属、遗留 `Actor`；
  - 受影响路由与模块用例：记忆、Webhook、任务路由与恢复、归档、上传、融合 / 来源追溯、系统概览。
- **集中验证**：全部实现写完后一次进行：
  - 静态检查；
  - 全量 SQLite；
  - 受影响用例的 PostgreSQL lane；
  - 在导出仓库里跑按已提交源码出报告的用例；
  - P0 变异 lane。
