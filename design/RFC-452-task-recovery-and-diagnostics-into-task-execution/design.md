# RFC-452 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`TE` = `S/modules/task-execution`，`L` = `S/services`，
`SH` = `packages/shared/src`。以 RFC-451 落地后的源码（`46f7160bb`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：task-execution 的 `application/recovery`、`application/lifecycleAlerts`、`application`、`infrastructure`、
  `infrastructure/local`、`application/ports`、`public/types`、`composition`；shared 的 `schemas/taskDiagnostics.ts`。
- **承担的演进**：W4 B / D 第十七步（`tasks` 路由的诊断 / 恢复 7 处 `services/` import 清零），并把 task-execution 留在 legacy 的恢复侧实现
  收回本模块（`R1` 18 条、`R2` 2 条随之清偿）。
- **跨 context 边**：无新增。迁入的文件只取 task-execution 自己的端口、shared、`@/platform/*` 与 `@/util/*`；唯一的 legacy 依赖是
  运行时清单读端取 `L/runtime` 的驱动能力表（task-execution 的 composition 与 infrastructure 早已这样取）。
- **留下的债**：`tasks` 路由的 workspace-insight 一族（下一个 RFC）；`L/runtime`（W5）；`L/daemonCadence`（平台与多个模块共用）。
- **偏离项**：无。

## 1. 文件落位（函数体原样，只改 import）

| 原位置                                   | 去向                                                    | 依据                                     |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `L/recovery.ts`                          | `TE/application/recovery/recoveryEvents.ts`             | 只经恢复端口记 / 读审计                  |
| `L/recoveryBreaker.ts`                   | `TE/application/recovery/autoRecoveryBreaker.ts`        | 只经恢复端口                             |
| `L/autoKill.ts`                          | `TE/application/recovery/heartbeatKill.ts`              | 杀进程经调用方注入                       |
| `L/autoRepair.ts`                        | `TE/application/recovery/autoRepair.ts`                 | 只经端口                                 |
| `L/autoResume.ts`                        | `TE/application/recovery/autoResume.ts`                 | 只经端口                                 |
| `L/taskWorkspacePhase.ts`                | `TE/application/recovery/taskWorkspacePhase.ts`         | 只经恢复端口                             |
| `L/runLiveness.ts`                       | `TE/application/recovery/runLiveness.ts`                | 纯判定 + 注入的观测                      |
| `L/shutdown.ts`                          | `TE/application/recovery/gracefulShutdown.ts`           | 只经关停 / 恢复端口                      |
| `L/lifecycleInvariants.ts`               | `TE/application/lifecycleAlerts/lifecycleInvariants.ts` | 只经恢复端口                             |
| `L/stuckTaskDetector.ts`                 | `TE/application/lifecycleAlerts/stuckTaskDetector.ts`   | 只经恢复端口                             |
| `L/taskAlerts.ts`                        | `TE/application/lifecycleAlerts/openLifecycleAlerts.ts` | 只经恢复端口                             |
| `L/runtimeSessionLease.ts`               | `TE/application/runtimeSessionLease.ts`                 | 只经租约端口                             |
| `L/orphans.ts`                           | `TE/infrastructure/local/orphanRunReap.ts`              | 经 `@/util/process` 查 / 杀本机进程      |
| `L/orphanReconcile.ts`                   | `TE/infrastructure/local/deadRunReconcile.ts`           | 经 `@/util/process` 探活本机进程         |
| `L/sessionView.ts`                       | `TE/infrastructure/sessionTreeRead.ts`                  | 未注入归档读端时读本机归档文件           |
| `L/execution/inventoryRead.ts`           | `TE/infrastructure/runtimeInventoryRead.ts`             | 取 `L/runtime` 驱动能力表                |
| `L/execution/startupVerificationRead.ts` | `TE/infrastructure/startupVerificationRead.ts`          | 未注入读模型时自建 infrastructure 读模型 |

- 迁入文件里对 task-execution 自己的 `@/modules/task-execution/{public,application}/…` 取法改成模块内的相对路径；声明在 application /
  domain / ports 里的直取声明处（例如 `createRunHistorySnapshot` 取 `application/runHistory`、`TaskSubject` 取 `domain/taskSubject`、
  两组恢复操作切片取 `application/ports/taskRecoveryOperations`、会话树读端的 `selectNodeRunPromptOperations` 取
  `composition/nodeRunPrompts`），声明在 public 里的仍经同模块 public 取（`runLiveness` 的 `wrapperInnerDescendantIds` 与同一条 import
  里的 `containerMemberRuns`、三个读端的读模型类型）；`L/eventsArchive`（兼容 re-export）改取
  `@/platform/background/eventsArchiveReader`。迁入文件里指向家族旧路径的注释同步改指新位置。
- **不经本模块 public 取值**（集中验证时查出）：会话树读端起初原样经 `public/participants` 取 `selectNodeRunPromptOperations`；
  `public/participants` 反过来从 composition barrel 取 `taskExecutionModule`，而 barrel 现在导出诊断装配 → 会话树读端，成了求值环
  （`ReferenceError: Cannot access 'taskExecutionModuleInternal' before initialization`，tsc / eslint 看不见）。改为直取声明处。
- `L/eventsArchive.ts`（`export *` 转出 `platform/persistence/sqlite/systemEventsArchive`）原来唯一的生产消费者是 `L/sessionView`；迁移后
  它成了不可达文件（集中验证时 `unreachable-production-files` 查出），删除；`scripts/perf-bench.ts` 与两个用例改取平台文件，
  `maintenance-soak-nightly.yml` 两份触发清单从这个两行的转出改指真正的 `systemEventsArchive.ts`。
- 17 个文件删除，不留 facade。分层：`application` 里的文件不取本模块 `infrastructure`、没有直接副作用（进程 / 文件 / 网络都经端口或
  调用方注入），`application-direct-effect-files` 与 `module-layer-violations` 不变。

## 2. 路由合同

- `SH/schemas/taskDiagnostics.ts`（shared index 导出）：
  - `TaskLifecycleAlertSchema`（id、taskId、rule ∈ `LIFECYCLE_ALERT_RULES`、severity ∈ warning / error、detail 对象、detectedAt）与
    `TaskAlertsResponseSchema`（`{ alerts }`）；
  - `TaskRecoveryEventSchema`（审计行原样：id、taskId / nodeRunId 可空、actor、kind、reason、beforeJson / afterJson、createdAt）与
    `TaskRecoveryEventsResponseSchema`（`{ events, suspended }`）；
  - `TaskDiagnoseResponseSchema`（scanned、newAlerts、promotedAlerts、resolvedAlerts、openAlerts：告警行加 `resolvedAt` 可空）。
    只用于类型（推导）与用例断言，运行时不额外解析，响应字节不变。
- `TE/application/ports/taskDiagnostics.ts`：
  - `TaskLifecycleAlertNotices`——`alert(notice, transition)` / `resolved(taskId)` 两个方法，notice 为既有的
    `TaskRouteLifecycleAlertNotice`；
  - `TaskDiagnostics`——`openAlerts(taskId)`、`recoveryHistory(taskId)`、`clearRecoverySuspension(taskId)`、
    `diagnose(taskId, notices)`、`sessionTree(taskId, nodeRunId)`、`runtimeInventory(taskId, nodeRunId)`、
    `startupVerification(taskId, nodeRunId)`；返回 shared 的推导类型（会话树取 `SessionViewResponse`）。
- `TE/public/types.ts` 导出这两个接口。
- `TE/application/taskDiagnostics.ts`：路由处理函数里的两段编排原样迁入——`readTaskRecoveryHistory`（`listRecoveryEventsForTask` 与
  `isAutoRecoverySuspended` 并发）与 `diagnoseTask`（`runLifecycleInvariants({ operations, scope: { taskId }, onAlert, onResolved })` 后
  再读一次未关闭告警，补上实时扫描没产出的行，`resolvedAt: null`；`onAlert` / `onResolved` 转给 `notices`）。
- `TE/composition/taskDiagnostics.ts`：`composeTaskDiagnostics({ recovery, readModels, nodeRunPrompts, archivedEvents?,
runtimeInventoryContent })` 只做绑定（RFC-423：composition 只装配，无循环 / 分支 / try / throw）——告警读、清除熔断取
  `listOpenLifecycleAlertsForTask` / `clearAutoRecoverySuspension`，恢复审计与诊断取上面两个用例，三个读端绑原路由传入的读模型、
  提示词操作、归档读端与运行时清单内容（归档读端可缺省：缺省时会话树读端照旧读本机归档文件）。
- 失败关闭：恢复操作与运行时清单内容是装配的必填参数，「没装配」在类型层不可表达（RFC-359 W1-T1；装配里不放运行期
  `*-not-composed` 检查）；原路由那两个错误码随之消失，路由改为缺 `diagnostics` 时抛 `task-diagnostics-not-composed`。
- `S/routes/tasks.ts`：7 个端点改调 `deps.diagnostics`；权限门（`requireOperator`）、参数读取与 `c.json` 形状留在路由；
  `TaskRouteDependencies` 去掉只为这些端点存在的 `taskRecoveryOperations` 与 `runtimeInventoryContent`，加 `diagnostics`；
  诊断的 `notices` 由路由接到 `tasksListBroadcaster`：告警广播抽成 `broadcastLifecycleAlert`，诊断的接收者与 `applyRepair` 的
  `onAlert` 共用它（载荷不变）。
- `S/bootstrap/daemonHttpComposition.ts`：`taskRoutes.diagnostics = composeTaskDiagnostics({ recovery: taskExecutionProvider.recovery,
readModels: taskExecutionProvider.readModels, nodeRunPrompts / archivedEvents: taskExecutionProvider.routes.tasks 的同名字段,
runtimeInventoryContent: input.selections.runtimeInventoryContent })`——与原来路由拿到的是同一批对象。

## 3. 其余接线

- task-execution 内部：`composition/providerBackground.ts`（心跳收割、死运行对账）、`composition/taskAutoResume.ts`、
  `infrastructure/taskLifecycleAutoRepairCommand.ts`、`infrastructure/local/bootExecutionRecovery.ts`（孤儿收割、租约修复）、
  `infrastructure/taskRouteRepairOperations.ts`（不变量与卡死检测）、`application/taskAgentRun.ts`、
  `infrastructure/local/nativeTaskAgentRunOptions.ts`、`infrastructure/taskRecoveryAdministration.ts`、
  `infrastructure/crewstation/bootRecovery.ts`（租约）改取模块内新位置。
- 装配根：`bootstrap/maintenanceJobBindings.ts`（每小时不变量扫描、卡死检测）与 `bootstrap/daemonSession.ts`（优雅关停）改从
  task-execution composition barrel 取（两者都是登记在册的装配根，可取 composition）；`daemonSession` 本就静态 import 这个 barrel，
  原来对 `L/shutdown` 的动态 import 改为同一条静态 import。
- composition barrel 增导出：`runLifecycleInvariants`、`runStuckTaskDetector`、`gracefulShutdown` 与 `composeTaskDiagnostics`。

## 4. 守卫、账本与用例

- **新用例** `T/rfc452-task-recovery-and-diagnostics-into-task-execution.test.ts`：17 个旧文件不存在、`S` 下零引用（census AST，别名与相对
  路径都认，带负对照）；`tasks` 路由不再 import 这 7 个模块；合同行为——`recoveryHistory` 并发读审计与熔断态、`diagnose` 把实时扫描
  没产出的未关闭行补进结果并把通知转给接收者、`openAlerts` 的详情解析与坏 JSON 回落沿用原语义；shared 三个 schema 认得出真实响应。
- **账本**：`architecture/commons-debt.json`（`R1` 18 条、`R2` 2 条删去；其余引用这些文件的条目改指新位置）；架构报告的 legacy 归属表
  删去 17 条登记；`rfc376-structural-guards` 的精确清单与 `guard-manifest.json` 中受影响守卫的行数随迁移刷新；`commons-manifest.json`、
  `T/fixtures/rfc395-selection-semantics-ledger.json`、`T/architecture/rfc328TaskExecutionLedger.ts` 里指向旧路径的条目改指新位置；
  `scripts/rfc359-p0-mutations.ts` 的受保护源文件清单改指新路径；`windows-platform.yml` 两份触发清单里的 4 个旧路径改指新文件
  （RFC-451 的 `ci-workflow-path-filters` 守卫第一次就拦下了它们）；`commons-debt.json` 里登记发现的锚点改指新路径，`runLiveness`
  因 import 换行整体上移 3 行，两处锚点同步改行号。
- **随迁的文本锁**：按路径段扫全部用例、e2e、脚本与 workflow（`ci-workflow-path-filters` 兜底触发清单），逐个改指新位置；
  `test-suite-policy`「模块级读取的源码路径都存在」兜底。
- **用例的 import**：54 个用例文件、76 处说明符改从新位置取；另有 13 个用例的源码文本锁 / 清单改读新位置（其中 `rfc331` 的 legacy
  消费方清单删去 `L/autoRepair` 及其两条已登记深引、`rfc339` 的「legacy 只经 public」清单删去已入模块的 `runLiveness`，
  `rfc349` 的失败关闭锁改为路由查 `task-diagnostics-not-composed`，两条随依赖消失的错误码由 RFC-452 用例的类型层断言代替）。
- **计数**（实测）：`services/` 205 → 187（含无人消费的 `eventsArchive` 转出）；`R1` 166 → 148；`R2` 35 → 33；模块里 import `services/` 的文件 139 → 134（不再取 legacy 的
  6 个、新迁入取 `L/runtime` 的 1 个）；import `services/` 的路由仍 1（`tasks` 余 workspace-insight 7 处）；平台 → 模块 0。

## 5. 失败模式

- 漏改的文本锁 / 清单：集中验证全量跑；`test-suite-policy` 与 `ci-workflow-path-filters` 兜底；
- public surface：合同只返回 shared 推导类型、通知用方法签名；`rfc294-architecture-preflight` 的精确债务清单兜底；
- 诊断合并的顺序与字段：用例逐字段比对原路由的输出（实时行在前、补入行在后、补入行 `resolvedAt: null`）；
- 分层：`application` 不取本模块 `infrastructure`、无直接副作用——`rfc376-structural-guards` 的精确清单兜底。

## 6. 测试策略

- 迁移的家族：既有用例改 import 后全部复跑（SQLite 全量 + PostgreSQL 受影响面）；
- 路由：`tasks` 的告警 / 恢复审计 / 清除熔断 / 诊断 / 会话 / 清单 / 启动验证 HTTP 用例原样通过；
- 新用例见 §4；P0 变异 lane（受保护文件清单改指新路径后）两引擎各 17 阶段符合预期。
