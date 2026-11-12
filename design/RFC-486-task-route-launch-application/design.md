# RFC-486 技术设计

落在 task-execution 一个 bounded context 内：用例编排进 `application/launch/`，端口进 `application/ports/`，纯规则进 `domain/`，持久化与
事件发布留在 `infrastructure/`，`composition/` 装配。不改启动语义、SQL、事务边界与次序。

## 1. 现状（HEAD `f6a7fadea`，源码实读）

- **文件**：`modules/task-execution/infrastructure/taskRouteLaunchOperations.ts` 1,457 行，按内容分：
  - 启动元数据与守卫（第 109～204 行）：由调用者推出 provenance、launch origin、intent source、触发 id 与终止快照，校验受保护 MR 守卫——
    纯规则；用户调用者的直接启动人经 `inbound/directTaskInitiator.ts` 由 actor source 推出（RFC-301：只有 inbound 观察 actor source）。
  - 端口类型（第 205～459 行）：工作区参与者三件（`TaskRouteWorkspaceRepository`、`TaskRoutePreparedWorkspace`、
    `TaskRouteWorkspaceParticipant`）、工作组资源投影、各臂依赖、根启动请求与内核、启动参与者——由 `infrastructure/hostTaskLaunch.ts`、
    `infrastructure/taskRouteWorkspaceParticipant.ts` 等实现，composition 装配。
  - 根启动内核（第 593～907 行）：把前检、准备、上传落地、准入、回滚、发布与交给驱动交给 `application/launch/launchTask.ts` 的步骤序列。
    准入（第 709～883 行）在一个可串行化事务里依次：守卫复核、活跃成员查询（`users`）、工作区 lane 准入、任务创建参与者、成员行
    （`task_collaborators`）、执行意图行、工作组状态行、任务创建事件；事务前用 `projectLaunchedTask`（第 460～547 行，经存储投影得出与读库
    一致的仓库面）投影返回的任务。发布用 `publishCommittedEventsAfterCommit`。
  - 两条启动臂、路由启动操作与启动参与者（第 908～1458 行）：编排既有端口；直接用到的 infrastructure 只有上传上限的配置文件读取
    （`resolveUploadLimits(configPath)` 两处）、任务授权查询（`createTaskAuthorizationQueries(db)` 一处）与工作组运行时配置的三个构建函数。
  - `findTaskAutomationReceipt`（第 1279～1295 行）：只被 `composition/taskRouteLaunch.ts` 的自动化开工 provider 与一个用例使用，与启动编排
    无关。
- **依赖里的持久化句柄**：`RootTaskLaunchDependencies` 收 `db`，两臂依赖收 `configPath`。
- **使用方**（语法树普查，按 import 计）：生产 10 个文件全在 task-execution（composition 5 个、infrastructure 5 个），除 `providerRuntime.ts`
  与 `composition/taskRouteLaunch.ts` 外都只取类型；后者把三个工厂与 11 个类型转给装配根，并取 `findTaskAutomationReceipt`。用例直接
  import 的 11 个文件（helper 5 个）。
- **点名该路径的文本断言**（`grep`，不含上面的 import）：架构账本 6 个（架构报告的文件清单、`rfc294-review-offered-edge-dag` 与
  `rfc376-structural-guards` 的越 DAG 文件对 `taskRouteLaunchOperations.ts -> integration`、`rfc328TaskExecutionLedger` 的路径正则、
  `rfc359-w7-task-insert-lineage-completeness` 的插入点清单、`rfc395-repository-boundary` 两处）与表归属债 fixture；读该文件源码做文本断言
  的用例 15 个（`rfc103`、`rfc104`、`rfc107`、`rfc108`、`rfc165-contract-v2`、`rfc287-t13`、`rfc301`、`rfc310-…-task-source-link`、`rfc345`、
  `rfc359-w10`、`rfc368`、`rfc370-workspace-upload-bindings`、`rfc459`、`source-text-rfc067-guards`、`tasks-scheduled-link`）；只在注释里
  提到的 7 个。
- **越 DAG 的 offered 文件对**：该文件取 integration 的 `ProtectedMrLaunchGuard` 类型，是 47 对里的一对；搬迁后由取该类型的新文件承接。
- **表归属债**（`tests/fixtures/rfc395-module-table-ownership-debt.json`，只减不增）：该文件两条——`task_collaborators`（owner collaboration；
  task-execution → collaboration 不在目标 DAG）与 `users`（owner identity-access）。同一族的债在 task-execution 里分别还有 8 个与 3 个文件。
  `rfc317-table-ownership` 用 `CONTENT_DEBT_SUCCESSORS` 承认内容搬迁：新键须在册、旧键的 hash 须在 `INITIAL_DEBT` 里。

## 2. 机制与落位

| 内容                                                                              | 落位                                                           | 说明                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动元数据、守卫校验、根启动内核的前检 / 准备 / 上传 / 准入请求 / 回滚 / 交给驱动 | `application/launch/rootTaskLaunch.ts`                         | 内核依赖改收端口：准入、上传落地、直接启动人推导；不再收 `db`                                                                                                                                                                                                              |
| 单代理与工作组两臂                                                                | `application/launch/taskLaunchArms.ts`                         | 上传上限改收 `resolveUploadLimits()` 端口函数，不再收 `configPath`                                                                                                                                                                                                         |
| 路由启动操作                                                                      | `application/launch/taskRouteLaunchOperations.ts`              | 任务授权改收 `TaskAuthorizationQueries`，不再收 `db`                                                                                                                                                                                                                       |
| 启动参与者                                                                        | `application/launch/taskExecutionLaunchParticipant.ts`         | 同上                                                                                                                                                                                                                                                                       |
| 工作区参与者三件、工作组资源投影                                                  | `application/ports/taskRouteWorkspace.ts`                      | 实现方（infrastructure）改从这里取类型；`admit(transaction)` 的参数仍是 `PersistenceDb` 类型                                                                                                                                                                               |
| 准入端口与准入请求                                                                | `application/ports/rootTaskAdmission.ts`                       | `admit(request)` 返回投影好的任务与事件引用；`publishAfterCommit(ref)`                                                                                                                                                                                                     |
| 上传落地端口                                                                      | `application/ports/taskLaunchUploads.ts`                       | 包 `applyTaskWorkspaceUploads` 的 db、上传内容与输入文件存储                                                                                                                                                                                                               |
| 准入事务、`projectLaunchedTask`、活跃成员查询、事件发布                           | `infrastructure/rootTaskAdmission.ts`                          | 事务内语句与次序逐条不变；两条表归属债随之改键                                                                                                                                                                                                                             |
| `findTaskAutomationReceipt`                                                       | `infrastructure/taskAutomationReceipts.ts`                     | 只搬家                                                                                                                                                                                                                                                                     |
| 工作组运行时配置的三个构建函数                                                    | `domain/workgroupRuntimeConfig.ts`                             | 纯函数（只依赖 shared 与 resource-catalog 的 public 类型），`childExecutionLaunchOperations.ts` 改取                                                                                                                                                                       |
| 启动守卫端口 `TaskLaunchGuard`                                                    | `application/ports/taskLaunchGuard.ts`，经 `public/types` 交出 | 成员：`signal`、`snapshot`、`assertCanCommit`、`verifyCanCommit`（内核用）与 `taskCommitted`、`launchSettled`、`failed`、`release`（`launchTask.ts` 用，原本地 `LaunchGuard` 改取它）；integration 的 `ProtectedMrLaunchGuard` 改为 `extends TaskLaunchGuard`（只多 `id`） |

- **准入请求的划分**：状态（失败 / 待运行）、错误摘要、分支默认值、成员去重、时间戳与两个 id 由 application 推出放进请求；行的拼装（任务创建
  参与者的入参、成员行、意图行与 `requestHash`、工作组状态行）与 `projectLaunchedTask` 在适配器里。事务内要调的守卫复核与工作区 lane 准入
  作为请求里的两个对象交入，适配器在事务里按原次序调用。
- **直接启动人**：内核依赖增 `directTaskInitiator(actor)`，composition 用 `inbound/directTaskInitiator.ts` 的函数装配——actor source 仍只在
  inbound 观察（RFC-301），application 不 import inbound。
- **composition**：`providerRuntime.ts` 建准入适配器、上传落地适配器、授权查询与上传上限函数交给三个工厂；`composition/taskRouteLaunch.ts` 的
  转出改指新位置，装配根的 import 不变。
- **表归属债**：fixture 里两条的 `file` 改为 `task-execution/infrastructure/rootTaskAdmission.ts`，`CONTENT_DEBT_SUCCESSORS` 增两条后继身份。

## 3. 账本与计数

- `MODULE_LAYER_RULE_DEBT` 不增（新 application 文件不 import `infrastructure/**` 与 `@/db/schema`）；`application-direct-effect-files` 不增。
- 越 DAG 的 offered 文件对 47 → 46：task-execution 不再取 integration 的类型，`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag`
  的精确清单销这一对；task-execution 的 public surface 增 `TaskLaunchGuard` 一个类型，由 integration 消费（未消费 public 符号不升）。
- 表归属债条数不变（两条改键）。跨 context 内部文件对不增。
- 文本账本按新路径更新；guard-manifest 新增本 RFC 用例一条，改到的用例刷新行数。`counts.json` 触及的项收紧到实测。

## 4. 用例

- **新增 RFC-486 用例**（登记 guard-manifest）：
  1. `infrastructure/taskRouteLaunchOperations.ts` 不存在；`application/launch/` 的四个文件不 import `infrastructure/**`、`inbound/**`、
     `@/db/schema`、drizzle 与 `@/platform/persistence/sessionTables`，内核与臂的依赖类型里没有 `db` 与 `configPath`（带负对照）；
  2. 准入适配器的事务内调用次序钉住（守卫复核 → 活跃成员 → lane 准入 → 任务创建 → 成员行 → 意图行 → 工作组状态 → 创建事件）；
  3. 工作组运行时配置只在 `domain/` 有一份；composition 用 inbound 函数装配直接启动人；task-execution 的生产文件不取 integration 的
     `ProtectedMrLaunchGuard`，`TaskLaunchGuard` 只有方法与只读字段签名、成员集合钉住，integration 的守卫扩展它；
  4. 双引擎行为：同一启动请求经新内核落库的任务行、成员行、意图行与返回投影与搬迁前相同（沿用既有启动用例的预言）。
- **既有用例**：import 旧路径的用例与 helper 改指新位置；构造内核与臂的 helper 补传新端口（准入适配器、上传落地、上传上限、授权查询、
  直接启动人）；文本账本改路径。

## 5. 失败模式

- 准入事务的语句或次序变化：由新用例的调用次序与既有双引擎启动用例（行、事件、返回投影）兜住。
- 端口装配遗漏：类型检查与启动用例兜住。
- 账本漂移：`rfc317-table-ownership`、guard-manifest 与架构报告门兜住。

## 6. 实施中的细化

（实施后补。）

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：编排与规则进 application / domain，持久化与事件发布在 infrastructure，装配在 composition。
- **C11**：task-execution 的 public 增 `TaskLaunchGuard`（integration 消费），不撤。
- **C12**：RFC-486 用例覆盖 `application/launch/` 全部文件、准入适配器与 composition 的装配点。
- **C13**：触及的减速带收紧到实测。
- **取舍（可推翻）**：
  1. `projectLaunchedTask` 留在适配器：它借存储投影保证返回的仓库面与读库一致，属于持久化形状；
  2. 直接启动人用装配期注入的函数，而不是让 application import inbound 或改 `ExecutionInvoker` 合同；
  3. 表归属债不在本 RFC 清偿：成员表一族横跨 task-execution 的 9 个文件，另立。
