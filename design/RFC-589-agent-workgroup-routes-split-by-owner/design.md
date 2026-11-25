# RFC-589 技术设计

记号：`S/` = `packages/backend/src/`，`RC/`、`TE/` 分别是 resource-catalog、task-execution 的模块目录。数字取 HEAD `7ff4408d4`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：代理与工作组的目录、详情、增删改、重命名、复制、ACL、闭包与资源状态进 `RC/inbound/http`；两个启动端点进
  `TE/inbound/http`；挂载函数经 `RC/composition.ts` 与 `TE/composition.ts` 转出。
- **不新增** DAG 之外的边：启动绑定取 resource-catalog public 的查询与授权上下文类型（task-execution → resource-catalog 是 offered-consumption）与
  task-execution 本模块的启动操作；resource-catalog 的两个绑定不再取 task-execution。
- **偏离项**：无。取舍：“读可见的代理 / 工作组”的小函数（各 6 行）是 resource-catalog 绑定里的闭包、还被资源状态与闭包端点用，启动绑定各带一份
  （同码同文的 404），不为它新开 public 查询。

## 1. 拆分与连接

- **`RC/inbound/http/agentRoutes.ts`**：`routes/agents.ts` 去掉 `POST /api/agents/:id/tasks`、只被它用的 import（multipart 解析、启动 schema、退役键
  检查、task-execution 的三个类型）与 `export type { AgentRouteTaskLaunchOperations }`；`AgentRouteDependencies` 去掉 `taskLaunch`。
- **`RC/inbound/http/workgroupRoutes.ts`**：`routes/workgroups.ts` 同样去掉 `POST /api/workgroups/:id/tasks`、只被它用的 import 与对
  `WorkgroupRouteTaskLaunchOperations` 的转出；`WorkgroupRouteDependencies` 去掉 `taskLaunch`。
- **`TE/inbound/http/agentTaskLaunchRoutes.ts`**：`mountAgentTaskLaunchRoutes(app, deps)`，依赖为 `queries`（`Pick<AgentQueries, 'get'>`）、
  `authorityFor`（`(actor) => AgentOperationContext`）与 `taskLaunch`（本模块 public 的 `AgentRouteTaskLaunchOperations`）；端点逐字搬入。
- **`TE/inbound/http/workgroupTaskLaunchRoutes.ts`**：`mountWorkgroupTaskLaunchRoutes(app, deps)`，依赖为 `queries`（`Pick<WorkgroupQueries, 'get'>`）、
  `authorityFor` 与 `taskLaunch`（`WorkgroupRouteTaskLaunchOperations`）；端点逐字搬入。
- **`server.ts`**：`agents` 一步先 `mountAgentRoutes`、再 `mountAgentTaskLaunchRoutes`，`workgroups` 一步先 `mountWorkgroupRoutes`、再
  `mountWorkgroupTaskLaunchRoutes`；每步两个绑定收同一个依赖对象（输入类型为两个依赖接口的交集）。别的挂载顺序不变。

## 2. 注册顺序

每步里启动端点从原来的中间挪到最后注册。这两个绑定没有中间件；代理与工作组的其余路由里没有能匹配 `POST /api/agents/:id/tasks` /
`POST /api/workgroups/:id/tasks` 的模式（`/:id/rename`、`/:id/copy`、`/closure-preview` 等段不同）；权限按路由声明（`tasks:execute`）不变。与别的挂载步骤
的相对顺序不变。

## 3. 门、用例与文档

- 架构报告归属表删两行；`counts.json` 的 `legacy-horizontal-files` 上限 58 → 56。
- 钉着旧路径的用例改指新位置；RFC-243 的启动调用面清单改为两个启动绑定（`taskLaunch.launch`、不取 `AppDeps` / `deps.db` 的断言跟过去），
  资源目录绑定不再是调用面；`rfc345` 对 `taskLaunch` 依赖声明的断言改读启动绑定；直接 import 旧路径的用例由搬迁脚本改写，打启动端点又只挂旧绑定的用例
  另挂启动绑定。
- 撤回（在候选报告上算到不动点）：两个资源目录绑定与两个启动绑定进了模块之后，下面 32 个 public 符号不再有别的模块消费，定义按 RFC-580 / RFC-581 的
  先例移进 `application/`（语法树搬迁，读者的 import 随之拆分）——
  - resource-catalog 的代理操作描述与它的输入 / 回执（`AgentOperationDescriptors`、`Create` / `Update` / `Delete` / `Rename` 的输入与删除回执，6 个）→
    `application/agents/operationContracts.ts`；工作组操作描述与它的输入 / 回执（8 个）→ `application/workgroups/operationContracts.ts`；
  - resource-catalog 只给代理绑定用的四个查询合同（依赖、导入、引用标签、资源完整性）与它们的输入 / 结果（14 个）→ `application/agents/queryContracts.ts`；
    `public/types` 里只服务这些合同的 7 个未导出小类型（引用标签、展示引用、展示 / 闭包问题、引用种类、问题码、展示状态）连同问题码要的
    `PluginDisabledErrorCode` import 一并移过去，仍不导出；
  - task-execution 的 `AgentRouteTaskLaunchOperations`、`WorkgroupRouteTaskLaunchOperations` 与只经前者可达的 `TaskRouteMultipartFilePart`、
    `TaskRouteUploadLimits` → `application/ports/subjectTaskLaunch.ts`（与 `taskDiagnostics.ts`、`taskWorkspaceQueries.ts` 同层）。
- 撤回连带的账本：`rfc305` 的 identity-access 消费者清单（新文件带走了 `AuthenticatedAuthoritySnapshot` 的 import）、`rfc552` 的 public/operations
  逐名清单、`rfc550` 的正对照、`rfc569` 的闭合声明清单与 `rfc345` 两处声明位置；`rfc439` 对 `routes/` 文件数的非空下限改为 `> 0`（只剩 10 个）。
- 新增 `T/rfc589-agent-workgroup-routes-split-by-owner-boundary.test.ts`，登记 guard-manifest：① 两个旧路径不存在，全部说明符不再解析到它们（带负对照）；
  ② 资源目录的两个绑定只取本模块，两个启动绑定只取本模块与 resource-catalog 的 `public/queries`、`public/participants`（带负对照）；③ 两个启动端点只在
  启动绑定里注册；④ `server.ts` 的 `agents`、`workgroups` 两步各挂两个绑定，资源目录的在前。

## 4. 失败模式

- **有人把启动端点放回资源目录的绑定**：那边又要取 task-execution，用例 ② 红，`rfc294-review-offered-edge-dag` 也红。
- **有人只挂资源目录的绑定**：启动端点 404；用例 ④ 红，启动的路由用例也红。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定按端点 owner 进模块。**C12**：RFC-589 用例 ① 覆盖全部说明符，② ～ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 58 → 56。
- **留下的债**：`routes/` 余 10 个——`registry`、`operationRoute`、identity-access 的路由（`auth`、`oidc`、`oidc-auth`、`users`、`operationAuthority`）与
  `accountRepositoryTransportCredentials`、`resourceAcl`（暂缓的那一组）以及 `taskCatalog`。
