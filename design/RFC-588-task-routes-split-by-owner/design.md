# RFC-588 技术设计

记号：`S/` = `packages/backend/src/`，`TE/`、`WI/` 分别是 task-execution、workspace-insight 的模块目录。数字取 HEAD `3469a00e1`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：任务路由进 `TE/inbound/http`；七个工作区洞察端点进 `WI/inbound/http`；挂载函数经 `TE/composition.ts` 与 `WI/composition.ts`
  转出。
- **不新增** DAG 之外的边：workspace-insight 的绑定取本模块 public、task-execution public 的 `TaskRouteOperations`（offered-consumption）与 shared 的
  `Config`；task-execution 的绑定不再取 workspace-insight 与 system-operations。
- **偏离项**：无。

## 1. 拆分与连接

- **`TE/inbound/http/taskRoutes.ts`**：`routes/tasks.ts` 去掉七个端点、`resolveStructuralDeepConfig` 与只被它们用的 import；`TaskRouteDependencies` 去掉
  `configuration`、`workspaceInsight`、`changeNarrativeAccess` 三项（连同对应的启动期检查）。可见性中间件留在这里，位置不变。
- **`WI/inbound/http/taskWorkspaceInsightRoutes.ts`**：`mountTaskWorkspaceInsightRoutes(app, deps)`，依赖为 `configuration`（本文件声明的
  `TaskWorkspaceInsightConfiguration`：`read()` 同步或异步给出 `Pick<Config, 'structuralDeepIndexers' | 'structuralDeepTimeoutMs' | …叙述用到的几项>`）、
  `workspaceInsight`（本模块 public 的 `TaskWorkspaceInsight`）、`changeNarrativeAccess`（原样搬来的本地形状）与 `operations`
  （`Pick<TaskRouteOperations, 'requireOperator' | 'get'>`）；三项启动期检查随之搬来。七个端点与 `resolveStructuralDeepConfig` 逐字搬入。
- **`server.ts`**：`tasks` 一步改为先 `mountTaskRoutes`、再 `mountTaskWorkspaceInsightRoutes`，两者收同一个依赖对象（输入类型改为两个依赖接口的交集）；
  别的挂载顺序不变（`taskArchive` 照旧在 `tasks` 之前）。

## 2. 门、用例与文档

- 架构报告归属表删一行、`catalogVisibility` 锚点改指新文件；`counts.json` 的 `legacy-horizontal-files` 上限 59 → 58。
- 读 `routes/tasks.ts` 源码的用例改读任务路由的新位置；断言落在七个端点上的改读工作区洞察绑定；直接 import 旧路径的用例由搬迁脚本改写；
  直接调 `mountTaskRoutes` 又打工作区洞察端点的用例（`rfc370-v16-code-review-services`）另挂新绑定。
- 撤回（在候选报告上算到不动点；报告按类型的声明认消费，别名与原类型算同一个）：两个绑定进了模块之后，它们取的本模块 public 类型不再有别的模块
  消费，连带只经这些类型可达的类型，共 13 个——
  - task-execution：`TaskWorkspaceQueries`（定义从 `public/queries` 移进 `application/ports/taskWorkspaceQueries.ts`，与 `TaskDiagnostics` 的端口文件
    同层；实现方 `application/workspaceRead.ts` 改从那里取）、`TaskDiagnostics`（只删 `public/types` 的转出）；
  - workspace-insight：`TaskWorkspaceInsight` 与只经它可达的 `ChangeNarrativeGenerating`、`ChangeNarrativeRuntimeSelection`、`CodeIntelQuery`、
    `FileContentResult`、`FileSymbolsQuery`、`StructuralDiffOptions`、`TaskFileContentQuery`、`ResolvedDeepConfig`、`DeepIndexerOverrides`（都只删
    `public/types` 的转出，绑定改从模块内的定义处取）；
  - resource-catalog：`McpDiagnosticsTranscript`（shared `SessionViewResponse` 的别名，唯一的跨模块引用是 `TaskDiagnostics` 的返回类型；别名移进它唯一
    的读者 `application/mcps/diagnosticsContracts.ts`）。
- 新增 `T/rfc588-task-routes-split-by-owner-boundary.test.ts`，登记 guard-manifest：① 旧路径不存在，全部说明符不再解析到它（带负对照）；② 两个绑定
  对模块的 import 只取本模块与登记过的入口（工作区洞察绑定：task-execution 的 `public/commands`）（带负对照）；③ 七个端点只在工作区洞察绑定里注册，
  可见性中间件只在任务路由里注册；④ `server.ts` 的 `tasks` 一步先挂任务路由、再挂工作区洞察绑定。

## 3. 失败模式

- **有人把工作区洞察绑定挂到任务路由之前**：七个端点会绕过可见性中间件；用例 ④ 红。
- **任务路由又取 workspace-insight 的 public**：用例 ② 红，`rfc294-review-offered-edge-dag` 也红（task-execution → workspace-insight 不在 DAG 上）。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定按端点 owner 进模块。**C12**：RFC-588 用例 ① 覆盖全部说明符，② ～ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 59 → 58。
- **留下的债**：`routes/` 余 12 个（`agents` / `workgroups` 下一批；传输工具与 identity-access 的路由；task-catalog）。`routes/registry.ts` 里一条注释
  还指着 `routes/tasks.ts:212`（那里早已改走 `registerRouteMiddleware`）：registry 属于暂缓的那一组、这几批只动它的 import 行，留到它归位时一起改。
