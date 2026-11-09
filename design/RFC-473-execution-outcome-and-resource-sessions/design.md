# RFC-473 设计

**落在哪个 context、哪一层**：task-execution `infrastructure`（结果投影的装配器经本模块读模型取行，资源会话开只读快照事务，都是适配层）。
**承担的演进**：W9-D 的一步——`services/execution/` 里只属于 task-execution、消费方也只在 task-execution 内部的三个文件归位，`R1` 少 4 条；
public 只收不放。**留下的债**：投影仍取 legacy `services/agentLaunch` / `services/codeRoundContract` 的两个节点 id 常量（EK-07 仍登记）；
资源会话仍取 legacy `services/runtime/types` 的 `ResolvedSkill` 类型（运行时驱动一族归 runtime-management 时一起走）；`services/nodeRollback.ts`
与 `services/execution/` 余下五个文件见 proposal §3。

## 1. 结果投影：`infrastructure/executionOutcome.ts`

- `services/execution/outcome.ts` 原样迁来，`projectExecutionOutcome` / `getExecutionOutcome` / `OutcomeTaskRow` / `OutcomeRunRow` /
  `OutcomeOutputRow` / `WorkgroupOutcomeInput` 与内部函数的函数体逐字不变。
- `ExecutionOutcome`（投影的返回形状）从 `services/execution/types.ts` 原样迁进同一文件（注释一并迁）。模块里另有一个同名类型
  `application/ports/executionEffect.ts` 的 `ExecutionOutcome`（动作执行效果的结果联合），两者各在自己的文件、按路径取，不改名。
- import 改取定义处：`createRunHistorySnapshot` ← `../application/runHistory`；`workgroupLaunchMode` 与 `TaskWorkgroupConfig` ←
  `../domain/taskWorkgroupConfig`；`TaskReadSubject` ← `../domain/taskSubject`；`TaskExecutionOutcomeReadModel` ← `../public/types`（定义在那里）；
  `createTaskExecutionReadModels` ← `./taskExecutionReadModels`。其余 import（`@/platform/content/locations/portArchive`、`@/util/errors`、
  `@/services/agentLaunch`、`@/services/codeRoundContract`、shared）不动。
- 消费方：`composition/actionExecutionEnvironment.ts` 与 `composition/childCallNodeExecution.ts` 取 `getExecutionOutcome`，
  `composition/digitalEmployeeExecution.ts` 取 `projectExecutionOutcome`，都改为 `../infrastructure/executionOutcome`。

## 2. `services/execution/types.ts` 删除

- `ExecutionOutcome` 见 §1；`ExecutionKind`、`ExecutionRef`、`StartExecutionRequest` 全仓零消费，删；`ExecutionInvoker` 的转出删
  （定义在 `public/commands`，生产消费方本就从那里取）。
- 两个用例（`rfc269-webhook-trigger-context-atomicity`、`helpers/webhookTaskExecution`）的 `ExecutionInvoker` 改取 `public/commands`；
  `helpers/executionTerminal` 的 `ExecutionOutcome` 改取新位置。

## 3. 资源会话：`infrastructure/taskExecutionResources.ts`

- `services/execution/taskExecutionResources.ts` 原样迁来，七个函数的函数体与六个类型逐字不变。
- 删掉它的四个转出（`TaskExecutionResourceAuthority` / `TaskExecutionResourceAuthorityPair` / `TaskExecutionResourceBinding` 类型，
  `createTaskExecutionResourceBinding`）——这正是那 3 条 `R1`。文件自己用到的三个类型改取 `../application/ports/taskExecutionResourceSnapshots`。
  其余 import（resource-catalog `public/types` / `public/participants`——task-execution → resource-catalog 是 offered 边、legacy
  `services/runtime/types` 的 `ResolvedSkill`、`@/util/errors`、`node:path`）不动。
- 模块内消费方改相对路径：`composition/taskEngineApplication.ts`（`createTaskAgentResourceSession` 与 `TaskAgentResourceSession`）、
  `composition/taskMechanicsState.ts`（`TaskAgentResourceSession`）、`composition/agentNodeExecution.ts` / `commitPushBinding.ts` /
  `mergeConflictResolution.ts`（`resolveSyntheticTaskAgentInjection`）；只取转出类型的 `composition/taskEngineRuntimeOptions.ts` 与
  `infrastructure/taskExecutionRuntimeParticipants.ts`（`TaskExecutionResourceBinding`）改取 `application/ports/taskExecutionResourceSnapshots`。
- 模块外：装配根 `server.ts` 的 `TaskExecutionResourceBinding`、legacy `services/task.ts` 的 `TaskExecutionResourceAuthority` 改取
  `@/modules/task-execution/public/commands`（那里早已转出这两个类型，与 `application/ports` 里的是同一个声明）。

## 4. public 只收不放

迁移后失去全部模块外消费方的转出收回（定义与模块内的取用不动）：`public/queries.ts` 的 `workgroupLaunchMode`——生产上只有结果投影
取它（用例都从 domain 或 shared 取）。

留下的：`TaskExecutionOutcomeReadModel`（定义在 `public/types.ts`，是 public `TaskExecutionReadModels` 接口的成员类型）与 `TaskReadSubject`
（另有三个 public 类型引用它，收回会让这些 public 签名指向不公开的类型）；`decodeTaskWorkgroupConfig` 在本 RFC 之前就没有模块外消费方，
计在既有的未被消费符号里，不在本 RFC 范围。以迁移后架构报告的「未被消费的 public 符号」实测核对：本 RFC 不新增未被消费的 public 符号，
也不新增 public 符号。

## 5. 行为等价

- 三处投影调用方取到的是同一个函数（逐字迁移），读点选择、种类分派、警告与错误三元组不变；`getExecutionOutcome` 仍经同一个读模型取行。
- 资源会话：同一个快照事务、同一组注入解析与同一个错误码；`server.ts` / `services/task.ts` 取的类型与原来转出的是同一个声明。
- 删掉的类型与转出没有运行时痕迹（`types.ts` 只有类型）。

## 6. 用例、账本与清单

- **import 改路径**（17 个用例 / helper）：`rfc243-execution-outcome`、`api-task-output-kind`、`rfc359-t3-action-execution-runners`、
  `helpers/executionTerminal` 改取 `infrastructure/executionOutcome`；取 `createTaskExecutionResourceBinding` 的十个用例 / helper 改取定义处
  `infrastructure/taskExecutionResourceSnapshots`；取 `TaskExecutionResourceAuthority` 的三个改取 `application/ports/taskExecutionResourceSnapshots`；
  `rfc370-isolation-workspace-bindings` 的 `resolveSyntheticTaskAgentInjection` 改取新位置；`ExecutionInvoker` 两处见 §2。断言不动。
- **按路径读 / 登记的**：
  - `architecture/commons-manifest.json`：公共内核 `projectexecutionoutcome` 的 `files` 改指新位置（`rfc317-identity-dispatch` 读不到文件时
    静默跳过，漏改等于让那个穷尽分派守卫失明——本 RFC 用例锁住清单里的文件都在）；
  - `architecture/commons-debt.json`：EK-07 的四个锚点改指新文件里对应的行（投影仍取 legacy 节点 id 常量，登记不销）；`R1` 销 4 条；
  - `tests/fixtures/rfc395-selection-semantics-ledger.json`：投影读点的 `site` / `path` 改指新位置（行号按实测）；
  - `tests/architecture/rfc395-task-definition-boundary`：读点清单里那一条改路径；
  - `tests/rfc345-resource-catalog-contracts`：读资源会话源码的路径改指新位置；
  - `tests/architecture/rfc405-agent-single-executor`：负对照里的 legacy 样例 `@/services/execution/taskExecutionResources` 换成仍在的
    `@/services/execution/triggerPreflight`（判据按 `services/` 前缀，换样例不改判据）；
  - `tests/architecture/architectureReport.ts`：owner 表删三条（模块文件不需要登记）；
  - `.github/workflows/windows-platform.yml`：两份路径过滤里的旧路径改为新路径；
  - 注释：`tests/architecture/rfc317-identity-dispatch`、`tests/helpers/legacyInjectionAgentLookup` 等指着旧路径的注释改指新位置。
- **guard-manifest**：改到的登记守卫文件刷新行数。

## 7. 失败模式

- 漏改公共内核清单 → `rfc317-identity-dispatch` 不报错却不再扫投影（`catch` 返回空）；本 RFC 用例锁「清单里每个文件都在」。
- 漏改 workflow 路径过滤 → Windows lane 在该文件变化时不触发；本 RFC 用例锁「两份过滤里没有已删除的文件」。
- public 收回漏掉模块外消费方 → tsc 报错；收多了 → 架构报告的未被消费符号或 public surface 计数与账本对不上。
- 模块内改取定义处时取错声明 → tsc 与 `rfc305` / `rfc376` 的报告类守卫同时报出。

## 8. 测试策略

新增 `tests/rfc473-execution-outcome-and-resource-sessions.test.ts`：

1. 三个旧文件不在；backend 的 src / 用例 / 脚本零 import 它们（`preProcessFile` 取全部模块引用，带负对照）；四个包、e2e、仓根脚本与
   `.github/workflows` 里没有指着它们的路径字面量（注释不算，带负对照）；`design/` 与 `docs/` 的 Markdown 相对链接不指着它们（CI 的
   lychee 逐条查仓内文件——RFC-472 的 Done 前 CI 就红在一条指向已删文件的 RFC-370 证据链接上，带负对照）。
2. 新位置的结构：投影与资源会话的导出名清单；`ExecutionOutcome` 在投影文件里；资源会话文件不再转出任何东西（没有 `export … from`）。
3. 依赖方向：两个新文件不取本模块 public 的值（模块内取定义处）；三处投影调用方与七处资源会话调用方取新位置；`server.ts` 与
   `services/task.ts` 的两个类型取自 `public/commands`。
4. public 收回：`public/queries` 不再转出 `workgroupLaunchMode`。
5. 清单：`commons-manifest.json` 里每个内核文件都在；投影内核指向新位置；`windows-platform.yml` 的路径过滤里每个具体文件都在。

既有用例照常覆盖行为（都改取新位置）：`rfc243-execution-outcome`（四种执行的投影，`getExecutionOutcome` 两引擎都跑）、
`api-task-output-kind`、`rfc359-t3-action-execution-runners`、`rfc310-pr4-execution-host` / `rfc363-task-preparation-admission` 等资源绑定用例、
`rfc317-identity-dispatch`、`rfc395-*` 选择语义与读点守卫。
集中验证按 RFC-472 的做法：导出仓库里全量 SQLite、改动闭包的 30 秒复跑与 PostgreSQL lane、P0、shared / frontend / system-mocks、文档用例与计数复核。
