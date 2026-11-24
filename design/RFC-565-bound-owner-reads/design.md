# RFC-565 技术设计

落在 task-execution、source-control（owner：撤出 public、装配根交出）、memory、integration（消费方：构造入参）与 bootstrap（在根句柄上建好并
交入）。另改 `PUBLIC_SURFACE_DEBT`、`architecture/counts.json`、钉着旧位置的用例，新增一个 RFC-565 用例。数字取 HEAD `4f1dcae66`。不改行为。

## 1. owner 一侧

| 位置                                                                   | 做法                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution `application/ports/taskKnowledgeQueries.ts`             | 新增 `TaskDistillationEvent`（原 `NodeEventContent` 的七个字段）与 `TaskKnowledgeQueries.distillationEvents(nodeRunIds)`                                                                     |
| task-execution `infrastructure/nodeEventQueries.ts`                    | `listNodeEventContents` 留作模块内函数，返回类型改用端口里的 `TaskDistillationEvent`                                                                                                         |
| task-execution `infrastructure/taskKnowledgeQueries.ts`                | `createTaskKnowledgeQueries(db, repositoryExists)`：仓库存在性片段作为第二个入参（文件内声明它的类型 `RepositoryExistsExpression`）；新增 `distillationEvents`，转给 `listNodeEventContents` |
| task-execution `infrastructure/taskTriggerQueries.ts`                  | 取表从构造时挪到各方法运行时：bootstrap 现在装配期就建好这份读，构造不该碰句柄（此前消费方每次调用现造一份，取表本来也发生在调用时）                                                         |
| task-execution `public/queries.ts`                                     | 撤出 `createTaskKnowledgeQueries`、`createTaskTriggerQueries`、`listNodeEventContents`、`nonTerminalTaskExists` 与类型 `NodeEventContent`；新增类型 `TaskDistillationEvent`                  |
| task-execution `composition.ts`                                        | 交出 `createTaskKnowledgeQueries`、`createTaskTriggerQueries`、`nonTerminalTaskExists`                                                                                                       |
| task-execution `infrastructure/crewstation/hostedRecoverySelection.ts` | 入参新增 `workspaceOwners`（`forBusinessTask(businessTaskId)`，只读 `taskId`），不再取 source-control 的函数                                                                                 |
| source-control `infrastructure/repositoryIdentityQueries.ts`           | 新增 `createRepositoryIdentityQueries(db)`（`existingIds(ids)`，转给 `existingRepositoryIds`）                                                                                               |
| source-control `infrastructure/crewstation/workspaceOwnership.ts`      | 新增 `createHostedWorkspaceOwnerQueries(db)`（`forBusinessTask(id)`，转给 `readHostedWorkspaceOwnerForBusinessTask`）                                                                        |
| source-control `public/queries.ts`、`public/participants.ts`           | 撤出 `existingRepositoryIds`、`repositoryExistsExpression`、`readHostedWorkspaceOwnerForBusinessTask`                                                                                        |
| source-control `composition.ts`                                        | 交出 `createRepositoryIdentityQueries`、`repositoryExistsExpression`、`createHostedWorkspaceOwnerQueries`                                                                                    |

## 2. 消费方一侧

| 位置                                                                                             | 做法                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory `infrastructure/memoryInjectionReadStore.ts`                                              | 构造入参新增 `taskKnowledge`（取 `injectionContext`、`repositoryIds`）与 `repositories`（文件内声明的 `RepositoryIdentityReads`：`existingIds`）              |
| memory `infrastructure/memoryDistillWorkStore.ts`                                                | 构造入参新增 `taskKnowledge`（取 `distillationScope`、`distillationSources`、`distillationEvents`），排在 `taskNodeOutputs` 之后、测试用的 `sinkFactory` 之前 |
| memory `composition.ts`                                                                          | `composeMemoryInjectionQueriesFor(db, taskNodeRuns, taskKnowledge, repositories)`；`ComposeMemoryOperationsOptions` 新增 `taskKnowledge`                      |
| integration `infrastructure/webhookDispatchPersistence.ts`                                       | `createWebhookDispatchPersistence(db, taskTriggers)`（取 `findByOrigin`、`status`）                                                                           |
| integration `infrastructure/webhookDeliveryQueries.ts`                                           | `createWebhookDeliveryQueries(db, taskTriggers)`（取 `terminalWorkspaces`）                                                                                   |
| integration `infrastructure/terminalWorkspaceAttribution.ts`                                     | `createWebhookTerminalWorkspaceAttributionQueries(taskTriggers)`（取 `workspaceAttribution`）：它不再需要句柄                                                 |
| integration `infrastructure/retentionPhase.ts`                                                   | `createWebhookFireRetentionPhase(db, nonTerminalTaskExists)`：片段作为入参（文件内声明它的类型 `NonTerminalTaskExists`），语句不变                            |
| integration `composition/webhookDispatch.ts`、`webhookIngress.ts`、`terminalWorkspaceCleanup.ts` | 五个装配函数各多一个 `taskTriggers` 入参（终态工作区清理策略的入参由 `db` 换成 `taskTriggers`）                                                               |

类型一律取 owner 留在 public 的闭合读类型（`TaskKnowledgeQueries`、`TaskTriggerQueries`，memory / integration → task-execution 是目标 DAG 上的边），
按用到的方法 `Pick`；source-control 的两个读没有现成的 public 类型，由消费方在自己文件里声明读到的形状，bootstrap 交入 owner 的对象（结构绑定）。

## 3. bootstrap

| 位置                           | 做法                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemonModules/memory.ts`      | `createTaskKnowledgeQueries(input.db, repositoryExistsExpression)` 与 `createRepositoryIdentityQueries(input.db)`，交给 memory 的两个装配函数 |
| `daemonModules/integration.ts` | `createTaskTriggerQueries(input.db)`，交给派发、投递与触发器服务三处                                                                          |
| `daemonApplication.ts`         | 终态工作区清理策略取 `createTaskTriggerQueries(input.db)`                                                                                     |
| `retentionSweepPhases.ts`      | `createWebhookFireRetentionPhase(db, nonTerminalTaskExists)`                                                                                  |
| `crewstation.ts`               | 托管恢复选择多交 `workspaceOwners: createHostedWorkspaceOwnerQueries(db)`                                                                     |

每一处交入的读都建在消费方原先自己用的那个句柄上；原先每次调用现造一个查询对象、现在装配时造一次。四个读在构造时都不碰句柄（触发读原先在
构造时取表，本 RFC 把它挪到方法运行时），所以装配期建它们不会比原来更早失败——句柄没有绑定会话时，报错仍发生在第一次调用。

## 4. 门与用例

- `PUBLIC_SURFACE_DEBT` 删去 11 条（task-execution 6、source-control 5），`counts.json` 的 `public-surface-deviations` 56 → 45。
- 钉着旧位置的用例随改：`rfc483-human-gate-badge-read-model-boundary`（正对照里“仍留在 public 的片段”换成别的名字，并断言 `nonTerminalTaskExists` 已
  撤出）、`rfc551-public-unconsumed-sweep-lock`（正对照里 source-control `public/queries` 的名字换成仍在的）、取这七个符号的行为用例改从 owner 的
  infrastructure 取。构造消费方的用例随入参更新（注入读存储统一经 `tests/helpers/memoryInjection.ts` 构造）。
- 新增 `tests/rfc565-bound-owner-reads-boundary.test.ts`，登记 guard-manifest：① 两个 owner 的 public 文件不导出七个符号（带正对照），装配根导出
  交入用的六个名字；② 全部模块的源码不从别的 context 取这七个符号（带负对照）；③ 消费方文件里读的来处是构造入参，bootstrap 从两个装配根取
  实现，`TaskKnowledgeQueries` 的方法集合逐个钉住；④ 编译期断言：owner 的实现交得进消费方的入参（任务知识读、触发读、两个片段、仓库身份读、
  托管工作区归属读）；⑤ 四个读在没有绑定会话的句柄上也能构造，调用时才报错，空入参照旧不碰句柄。
- `rfc395-a7-owner-queries` 补 `distillationEvents` 与 `listNodeEventContents` 同序同值、绑定后的仓库身份读与函数同答的断言；
  `rfc359-w4-b4c-adapters` 补蒸馏工作存储经任务知识读取事件正文的断言（此前只测了空结果）。都跑两种数据库。

## 5. 失败模式

- **owner 改了读的形状而消费方还按旧的读**：bootstrap 的交接处与 RFC-565 用例的编译期断言报类型错误。
- **有人把这些读重新从 public 交出，或消费方重新用句柄去造 owner 的读**：RFC-565 用例 ① ② 与 `PUBLIC_SURFACE_DEBT` 的精确比对同红。
- **装配时漏交**：入参必填，`tsc` 报错。
- **有人让某个读在构造时就取表**：RFC-565 用例 ⑤ 红。

## 6. 取舍（可推翻）

1. **交入建好的读，而不是工厂引用**：RFC-482 给 collaboration 交的是工厂引用，因为它的调用点有的在事务里、要把手里的事务句柄传进去。这里七处
   消费方全部在根句柄上读（装配函数拿到的 `db`），交建好的读更窄——消费方不再把句柄交给别的 context，RFC-485 给 memory 交节点运行读就是这样做的。
2. **两个 SQL 片段仍是函数引用**：它们要拼进消费方自己的那条语句（保留清理的候选集、蒸馏范围的同行投影），拆成两条语句会改变查询条数（两处都有
   条数预算用例）。片段的类型由消费方在自己的 infrastructure 文件里声明，不进任何 public。
3. **`listNodeEventContents` 并入 `TaskKnowledgeQueries`**：它与 `distillationScope`、`distillationSources` 是蒸馏消费的同一组投影，并进去后 memory
   只多一个入参；函数本身留作 task-execution 模块内的实现。
4. **source-control 的两个读不新增 public 类型**：各只有一个方法、一个消费方，由消费方声明读到的形状（仓库身份读只要 `existingIds`，托管归属读只要
   `taskId`），public 面只减不增。
5. **装配函数用位置入参续写**：memory 与 integration 现有的装配函数都是位置入参，沿用；用例一侧的重复由测试助手收口。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：读的实现留在 owner 的 infrastructure，闭合类型在 owner 的 `application/ports`；消费方只在 infrastructure 的构造入参里声明依赖。**C11**：两个
  owner 的 public 各撤出若干符号（task-execution 5 个、source-control 3 个），新增 1 个类型（`TaskDistillationEvent`）。**C12**：RFC-565 用例覆盖全部
  模块的源码与六处结构绑定。**C13**：public 类型偏差 56 → 45，其余计数不升；目标 DAG 不变。
- **本 RFC 承担的演进**：S9 范围第 2 项里“收裸 db 句柄的查询工厂换成 owner 提供的业务查询”在 task-execution 与 source-control 两个 owner 上成立。
- **留下的债**：resource-catalog 的同类 6 条（含退出门点名的 `workflowNameExpression`）、`repositoryScopeExistenceReads` 1 条与其余 38 条。
