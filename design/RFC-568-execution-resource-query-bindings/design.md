# RFC-568 技术设计

落在 resource-catalog（撤出 public、装配根交出）、task-execution / intent / knowledge-evolution（消费方：构造入参）与 bootstrap（从 resource-catalog 的
装配根取工厂交入）。另改 `PUBLIC_SURFACE_DEBT`、`architecture/counts.json`、钉着旧位置的用例，新增一个 RFC-568 用例。数字取 HEAD `f8dc493ec`。不改行为。

## 1. owner 一侧

| 位置                                 | 做法                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| resource-catalog `public/queries.ts` | 撤出 `createAgentExecutionQueries`、`createWorkflowExecutionQueries`；`AgentExecutionQueries` 等闭合读类型照留 |
| resource-catalog `composition.ts`    | 交出两个工厂（实现不动；本模块内部的两处使用照旧直接取）                                                       |

## 2. 消费方一侧

消费方拿到的是**工厂引用**，依赖成员就叫工厂的名字（`createAgentExecutionQueries` / `createWorkflowExecutionQueries`），调用点照旧把自己手里的句柄传
进去。类型由各消费方按自己用到的方法声明（返回值是 resource-catalog 留在 public 的闭合读类型的 `Pick`）。

| 位置                                                               | 做法                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution `infrastructure/executionResourceReads.ts`（新）    | 声明两个工厂引用的类型 `AgentExecutionQueriesFactory`、`WorkflowExecutionQueriesFactory`，以及“句柄加工作流读工厂”的 `WorkflowReadSource`                                                         |
| task-execution `infrastructure/taskRouteOperations.ts`             | `TaskRouteOperationsDependencies` 多 `createWorkflowExecutionQueries`；两处使用改取它。读任务详情的一串函数（`loadTask` 等）的首个入参由句柄改为 `WorkflowReadSource`，七个窄依赖类型随之多这一格 |
| task-execution 的任务详情读                                        | `taskDetailRead.ts` 的 `getTask(source, id)` 与 `taskDetailQueries.ts` 的 `createTaskDetailQueries(db, factory)` 同样收工厂；唯一的生产读者 `deferredRepositoryPreparation.ts` 的依赖多这一格     |
| task-execution `infrastructure/fusionEngineTaskOperations.ts`      | `FusionEngineTaskDependencies` 多 `createWorkflowExecutionQueries`                                                                                                                                |
| task-execution `infrastructure/childExecutionLaunchOperations.ts`  | `ChildExecutionLaunchDependencies` 多 `createWorkflowExecutionQueries`（调用点仍传事务句柄）                                                                                                      |
| task-execution `infrastructure/taskSubjectQueries.ts`              | 构造入参多工厂引用；装配文件交出 `bindTaskSubjectQueries(factory)`，它返回 collaboration 的绑定里那个 `(db) => TaskSubjectQueries`                                                                |
| task-execution `application/ports/actionExecution.ts` 与脚本执行器 | 执行环境多一个读 `catalogWorkflowDefinition(workflowId)`（目录里的工作流定义原文，没有则为 null）；环境绑定用依赖里的工厂在环境的 `db` 上实现，应用层不再碰工厂                                   |
| task-execution `infrastructure/workgroupTurnsPersistence.ts`       | `WorkgroupTurnsDependencies` 多 `createAgentExecutionQueries`（调用点仍传快照读事务句柄）                                                                                                         |
| task-execution `infrastructure/dynamicWorkflowPersistence.ts`      | 构造入参多 `createAgentExecutionQueries`                                                                                                                                                          |
| task-execution 的装配文件                                          | `providerRuntime`（交给任务路由、融合任务与子任务铸造）、`workgroupTurns`、`dynamicWorkflowPersistence`、延后的仓库准备、动作执行环境各自把工厂转交下去                                           |
| intent `infrastructure/intentSqlPersistence.ts` 与两个构造函数     | 持久化的构造入参多 `createAgentExecutionQueries`（只读 `portNames`）；三个装配函数随之                                                                                                            |
| knowledge-evolution `infrastructure/fusionRepository.ts`           | `createFusionPersistence` 的入参多 `createWorkflowExecutionQueries`（只读 `summaries`）；装配函数随之                                                                                             |

## 3. bootstrap

从 resource-catalog 的装配根取两个工厂：`daemonModules/taskExecution.ts`（provider runtime、工作组轮次、动态工作流持久化、延后的仓库准备）、
`daemonModules/developmentAutomation.ts`（两个动作执行器的环境）、`crossContextClosure.ts`（用 `bindTaskSubjectQueries` 造出交给 collaboration 的
`createTaskSubjectQueries`）、intent 与 knowledge-evolution 的 daemon 模块、维护 worker 的 intent 维护命令，以及 `daemonHttpComposition.ts` 自己那一处。

工厂是无状态的函数（每次调用按传入的句柄现造一份读）；交入的是原来消费方 import 的同一个函数，所以每次读用的句柄、语句与条数都不变。

## 4. 门与用例

- `PUBLIC_SURFACE_DEBT` 删去 2 条，`counts.json` 的 `public-surface-deviations` 42 → 40。
- 取这两个工厂的用例改从 resource-catalog 的 infrastructure 取；构造上述消费方的用例与助手补入参（与 bootstrap 交的是同一个函数）。按句柄读任务
  详情的 23 个用例文件与另外 5 个测试助手改从新的 `tests/helpers/taskDetailRead.ts` 取 `getTask`：它保留 `getTask(db, id)` 的形状，内部绑上 owner 的
  工厂。
- 新增 `tests/rfc568-execution-resource-query-bindings-boundary.test.ts`，登记 guard-manifest：① resource-catalog 的 public 文件不导出两个工厂（带
  正对照），装配根交出；② 全部模块的源码不从 resource-catalog 取它们（带负对照；owner 自己除外）；③ 九处消费方用入参里的工厂、调用点传的还是
  原来那个句柄，bootstrap 从装配根取；④ 编译期断言：owner 的工厂交得进每个消费方声明的入参。另有一条行为用例覆盖执行环境新增的那个读。
- 行为：两个工厂的结果由 `rfc395-a7-owner-queries` 覆盖（两种数据库）；九处消费方的结果由既有的任务路由、融合任务、子任务铸造、工作组轮次、动态
  工作流、动作执行、Intent 资源目录与融合持久化用例覆盖。

## 5. 取舍（可推翻）

1. **交工厂引用，而不是建好的读**：九处里有两处在事务里读（子任务铸造的锚点检查、工作组轮次的快照读），任务主体查询与 Intent 持久化的句柄也由调用方
   决定；RFC-482 给 collaboration 交 task-execution 的读时遇到同样的情形，定的就是“交工厂引用，每个调用点传自己手里的句柄”。应用层的动作执行器是
   例外：它不该看见收句柄的工厂，所以执行环境多一个按 id 取目录工作流定义的读，环境绑定用工厂在环境自己的 `db` 上实现（与环境里既有的
   `taskStatus` 同一做法）。
2. **依赖成员沿用工厂的名字**：调用点从 `createWorkflowExecutionQueries(tx)` 变成 `dependencies.createWorkflowExecutionQueries(tx)`，读起来是同一件事；
   用例一侧补一个同名成员即可。
3. **类型由消费方按用到的方法声明**：返回值取 owner 留在 public 的闭合读类型再 `Pick`，owner 改了别的方法不牵动消费方。
4. **Intent 的三个装配函数都收工厂**：持久化只有一份实现，维护路径虽然不读代理端口，也由同一个构造函数造出；给它一个“会抛错”的替身不如如实交入。

## 6. 失败模式

- **owner 改了工厂或读的形状**：bootstrap 的交接处与 RFC-568 用例的编译期断言报类型错误。
- **有人把工厂重新从 public 交出，或消费方重新从 resource-catalog 取它**：RFC-568 用例 ① ② 与 `PUBLIC_SURFACE_DEBT` 的精确比对同红。
- **装配时漏交**：入参必填，`tsc` 报错。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：读的实现留在 resource-catalog 的 infrastructure、闭合类型在它的 `application/ports`；消费方只在构造入参里声明依赖。**C11**：resource-catalog
  的 public 撤 2 个符号。**C12**：RFC-568 用例覆盖全部模块的源码、九处消费方与结构绑定。**C13**：public 类型偏差 42 → 40，其余计数不升；目标 DAG 不变。
- **本 RFC 承担的演进**：S9 范围第 2 项里“收裸 db 句柄的查询工厂”在三个 owner（task-execution、source-control、resource-catalog）上都已撤出 public
  （暂不动的两条能力类合同除外）。
- **留下的债**：`IntentSkillArtifactOwner`、`repositoryScopeExistenceReads` 与其余 38 条。
