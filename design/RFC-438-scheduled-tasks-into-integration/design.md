# RFC-438 技术设计

路径缩写：`S` = `packages/backend/src`，`T` = `packages/backend/tests`，`I` = `S/modules/integration`，`TE` = `S/modules/task-execution`，
`RC` = `S/modules/resource-catalog`。以 RFC-437 收尾后的源码（`bf38c3bd2`）为准。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：
  - integration：`application`（定时任务用例与节拍）、`application/ports`（变更通知）、`inbound/http`（管理面绑定）；
  - task-execution：`application/ports`（结构同形的本域定时启动合同，不进 public；合同本身由 integration 的 `application/ports/scheduledLaunch.ts` 以 consumer-owned 方式声明）；
  - resource-catalog：`public/types` 导出访问档位的两个纯投影；
  - composition、`server.ts` 与 bootstrap 只改连接。
- **承担的演进**：W4 B / D 第四步，并执行 RFC-294 design §2「`services/` 按 owner 迁入模块后删除」：
  - `R1` 178 → 176，深引模块内部的路由 3 → 2，import `services/` 的路由 24 → 23；
  - task-execution 不再 import 定时任务的任何文件，DAG 只剩 integration → task-execution 一个方向。
- **不新增** DAG 之外的边与 R2 边。他域依赖改从 owner 取：
  - 定时启动合同 `ScheduleLaunch` / `BuildScheduleLaunch` 由 integration 以 consumer-owned 端口声明（`application/ports/scheduledLaunch.ts`）；
    实现仍是 task-execution 的启动闭包，task-execution 留一份结构同形的本域合同，bootstrap 连接。合同含 legacy `Actor` 与函数类型，
    不能进 task-execution 的 public 面（public 面规则与 RFC-400 的「public 签名不带 legacy Actor」）；
  - 访问档位投影 `canEditAccess` / `canGovernAccess` 是 resource-catalog domain 的纯函数，经 `public/types` 导出（integration → RC 在 DAG 内）；
  - 工作流触发预检、启动入参校验与 agent 启动形状校验并入已有的 `IntegrationTriggerValidationRuntime`，由 bootstrap 连接 legacy 实现；
  - WS 广播改为 integration 的变更通知端口，由 composition 连接。
- **留下的债**：
  - `services/scheduledTaskRefs.ts` 仍在 legacy（resource-catalog 的删除守卫使用，需要 RC 定义所需端口后由 integration 实现）；
  - 绑定仍用 `services/deleteConfirm` 与 `services/tokenAudit` 两个 HTTP 传输助手（十余个路由共用，归位 platform/http 另立）；
  - `I/composition/webhookAdmission.ts` 含校验逻辑，以及它对 legacy 触发预检的调用，随下一步 composition 收口处理。

## 1. 文件去向

| 原文件                                  | 新位置                                    | 说明                                                                                                                     |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `S/services/scheduledTasks.ts`          | `I/application/scheduledTasks.ts`         | 依赖改从 owner 或端口取；去掉 `scheduledRowsReferencing` 的转出与运行期 heal                                             |
| `S/services/scheduledTaskScheduler.ts`  | `I/application/scheduledTaskScheduler.ts` | 广播改走变更通知端口                                                                                                     |
| `S/routes/scheduledTasks.ts`            | `I/inbound/http/scheduledTaskRoutes.ts`   | 原样搬迁，依赖改指本模块与 owner                                                                                         |
| `healScheduledLaunchPayloads`（服务内） | `T/helpers/scheduledPayloadHeal.ts`       | 自 RFC-395 II-b 起由 epoch-2 转换规则 `integration/boot-scheduled-payload` 取代，生产零调用；按 RFC-424 先例迁入用例辅助 |

## 2. task-execution 的方向倒转（G2）

- `I/application/ports/scheduledLaunch.ts`（新）接收 `ScheduleLaunch` 与 `BuildScheduleLaunch`（原在 `services/scheduledTasks.ts`），
  integration 的服务、节拍与绑定从这里取；`I/composition/scheduledTasks.ts` 转出类型供 bootstrap 使用。
- `TE/application/ports/scheduledLaunch.ts`（新）是 task-execution 自己的同形合同，`TE/infrastructure/taskExecutionTrigger.ts` 与
  `TE/composition/providerRuntime.ts` 从这里取；不经 public 导出。bootstrap 把 TE 运行时的 `trigger.buildScheduleLaunch` 交给 integration，
  两边结构同形由类型检查在连接处核对。
- `TE/composition/providerBackground.ts`：
  - 启动入参 `scheduled` 由 `{ operations, identityAccess, loadConfig?, onAutoDisable? }` 收窄为 application 端口已有的
    `{ loadConfig?, runDue(input) }`；
  - 不再 import 节拍与定时任务服务；循环、开关判定与暂停恢复仍在 `TE/application/providerBackground.ts`，不变。
- integration 提供「跑一轮」：`I/composition/scheduledTasks.ts` 新增 `composeScheduledTaskRunner({ operations, identityAccess, buildLaunch,
onAutoDisable? })`，返回 `runDue({ maxFailures, defaultRuntime })`，内部调用 `runDueSchedulesOnce`，限额 `SCHEDULE_MAX_IN_FLIGHT`，
  与原 TE composition 里的闭包逐字等价。
- bootstrap（`daemonSession.ts`）把 `runDue` 交给 TE 后台；`buildLaunch` 取 TE 运行时已有的 `trigger.buildScheduleLaunch`。
- 节拍间隔 `SCHEDULE_TICK_MS`（30 s）原由 TE composition 从 legacy 节拍文件取来交给循环。它是守护进程的节奏常量，移入节奏登记表
  `DAEMON_CADENCE.scheduledTasks`（TE composition 本就从这里取其他节奏），值不变；并发上限 `SCHEDULE_MAX_IN_FLIGHT` 随节拍迁入 integration。
- 触发器校验的三个 legacy 成员不进 `IntegrationTriggerValidationRuntime`（bootstrap 与用例夹具构造的入参保持两个成员），由
  `composeScheduledTaskRuntime` 在组装 `operations.validation` 时补上；agent 启动形状校验仍按原样惰性加载。

## 3. 他域机制改走端口（G3）

- **触发器校验**：`operations.validation` 的类型扩成 `IntegrationTriggerValidationRuntime` 加三个成员，调用顺序与原文件逐行一致：
  `assertTriggerPreflight(input)`、`assertWorkflowLaunchInputs(declared, provided)`、`validateAgentLaunchShape(...)`（异步，内部仍惰性加载）。
  三个成员由 integration 的 `composeScheduledTaskRuntime` 用 `services/execution/triggerPreflight`、`services/workflowLaunchInputs`、
  `services/agentLaunch` 连接（composition 可连 legacy；RFC-303 锁只约束 integration 的非 composition 文件）。
- **变更通知**：`I/application/ports/scheduledTaskNotifications.ts`（新）声明 `ScheduledTaskChanged`
  （`scheduled.created` / `updated` / `deleted` / `fired` 四种，字段与原广播逐字相同）与 `notify(change)`；
  `ScheduledTaskOperations` 新增 `notifications`，`I/composition/scheduledTasks.ts` 用 `scheduledTaskBroadcaster` 与 `SCHEDULED_TASK_CHANNEL` 连接。
- **访问档位**：`RC/public/types.ts` 转出 `canEditAccess`、`canGovernAccess`（RC domain 的纯投影）；服务与绑定改从这里取。

## 4. 绑定

`I/inbound/http/scheduledTaskRoutes.ts` 原样搬迁：

- 用例来自 `../../application/scheduledTasks`；访问档位投影来自 RC `public/types`；identity-access 只用 `public/participants`；
- 仍用 `services/deleteConfirm` 与 `services/tokenAudit` 两个 HTTP 传输助手（§0 留下的债，源码锁按白名单放行这两个）；
- `I/composition.ts` 转出挂载函数，`server.ts` 经 composition 挂载。

## 5. 其他 import 方

- `server.ts`：`IntegrationTriggerResourceBinding` 改用 integration 端口的 `IntegrationTriggerResourceQueries`（经 composition 转出）。
- `bootstrap/daemonApplication.ts`、`daemonHttpComposition.ts`：`BuildScheduleLaunch` 改取 integration `composition/scheduledTasks` 转出的类型
  （RFC-439 订正：此处原写「改取 TE `public/commands`」，与实现不符）。
- integration：`composition/webhookAdmission.ts`、`composition/webhookDispatch.ts`、`composition/scheduledTasks.ts`、
  `infrastructure/webhookDispatchRuntime.ts` 改从本模块 application 取。
- 用例与辅助文件：约 22 个引用旧路径的文件改指新位置；heal 用例改从 `T/helpers/scheduledPayloadHeal.ts` 取。

## 6. 账本与计数（实测为准）

- `architecture/commons-debt.json`：删去 `routes/scheduledTasks.ts` 与 `services/scheduledTasks.ts` 的两条 R1 边，`inboundEdges` 178 → 176。
- RFC-305 identity-access 消费者账本：`routes/scheduledTasks.ts`、`services/scheduledTasks.ts` 改为新路径。
- 架构报告的 legacy 归属表删去三个已删文件；引用旧路径的源码锁改指新位置；`counts.json` 只降不升；guard-manifest 刷新行数。
- 路由错误码棘轮：绑定在 `modules/*/inbound/*` 语料内，服务迁入 application 不影响路由语料（原服务的码本就不在语料里）。

## 7. 失败模式

- **节拍漂移**：`runDue` 闭包与原 TE composition 逐字等价；节拍、开关与暂停恢复不动。用例断言 TE 后台经端口跑满一轮、限额不变。
- **校验顺序漂移**：三个新端口成员在原调用点按原顺序调用；RFC-159 / RFC-165 / RFC-287 的触发器校验用例原样复跑。
- **广播漂移**：四种变更事件的字段逐字保留，WS 用例复跑。
- **方向残留**：新增源码锁断言 task-execution 不 import 任何定时任务文件，迁入文件不 import legacy `services/`（两个传输助手除外）。

## 8. 测试策略

- **新用例** `T/rfc438-scheduled-tasks-into-integration.test.ts`：
  - 三个原文件不存在、新文件就位，heal 不在生产源码中；
  - 迁入文件与绑定的依赖白名单；task-execution 源码不 import 定时任务；
  - `composeScheduledTaskRunner` 的 `runDue` 跑一轮：认领、触发、限额与自动停用回调；
  - 变更通知端口收到四种事件，字段与原广播相同；
  - 生产应用里定时任务路由的元数据不变。
- **改指的用例**：约 22 个引用旧路径的文件；heal 用例改从用例辅助取。
- **回归**：定时任务的创建 / 更新 / ACL / 触发 / 立即运行、Webhook 触发器校验、TE 后台、WS 与架构测试。
- **集中验证**：全部实现与用例写完后一次进行：静态检查、全量 SQLite、受影响用例的 PostgreSQL lane、导出仓库、P0 变异 lane。
