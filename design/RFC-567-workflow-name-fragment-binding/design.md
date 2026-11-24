# RFC-567 技术设计

落在 resource-catalog（撤出 public、装配根交出）、task-execution（五处读模型从入参拿片段）与 bootstrap（从 resource-catalog 的装配根取实现交入）。
另改 `PUBLIC_SURFACE_DEBT`、`architecture/counts.json`、钉着旧位置的用例，新增一个 RFC-567 用例。数字取 HEAD `948d2353c`。不改行为。

## 1. owner 一侧

| 位置                                 | 做法                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| resource-catalog `public/queries.ts` | 撤出 `workflowNameExpression`                                  |
| resource-catalog `composition.ts`    | 交出 `workflowNameExpression`（实现不动，仍在 infrastructure） |

## 2. task-execution 一侧

片段的类型声明在 `infrastructure/taskRepositorySql.ts`（`WorkflowNameExpression`，紧挨着把它拼进任务行的 `taskWorkflowNameSql`）。五处读模型的入参：

| 位置                                                 | 做法                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/taskListPage/query.ts`               | `baseCtes`、`rootQuery`、`childQuery`、`fastDefaultRootQuery`、`fastFilteredRootQuery` 在 `db` 之后多一个 `workflowName` 入参                                                                      |
| `infrastructure/taskListPage/filters.ts`             | `nonViewCondition` 同样多一个 `workflowName`                                                                                                                                                       |
| `infrastructure/taskListPage/page.ts`、`database.ts` | `TaskListPageDeps` 多 `workflowName`；`createDatabaseTaskListPage(db, owners, workflowName)`                                                                                                       |
| `infrastructure/taskCatalogSources.ts`               | 目录源的两个装配函数多一个 `workflowName` 入参，转给列表页                                                                                                                                         |
| `infrastructure/taskRouteOperations.ts`              | `TaskRouteOperationsDependencies` 多 `workflowName`；`taskListSummariesProjection(db, workflowName, filters)`、`taskListItemsProjection({ db, owners, workflowName }, filters)` 与内部两个函数随之 |
| `infrastructure/taskLifecycleWsProjection.ts`        | 两个工厂多一个 `workflowName` 入参                                                                                                                                                                 |
| `infrastructure/taskGateQueries.ts`                  | `taskGateOpenCondition` 改由 `bindTaskGateOpenCondition(workflowName)` 造出（签名不变）；模块外只有 collaboration 经 bootstrap 的绑定用它                                                          |
| `composition.ts`、`composition/providerRuntime.ts`   | 装配根交出 `bindTaskGateOpenCondition`；provider runtime 的依赖多 `workflowName`，交给任务路由与生命周期投影                                                                                       |

## 3. bootstrap

| 位置                             | 做法                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `daemonModules/taskExecution.ts` | 从 resource-catalog 的装配根取 `workflowNameExpression`，交给 provider runtime 与任务目录源            |
| `crossContextClosure.ts`         | 交给 collaboration 的 `taskGateOpenCondition` 改成 `bindTaskGateOpenCondition(workflowNameExpression)` |

片段是无状态的函数：每个调用点仍把自己手里的句柄传给它，拼出的 SQL 与原来逐字相同。

## 4. 门与用例

- `PUBLIC_SURFACE_DEBT` 删去 3 条，`counts.json` 的 `public-surface-deviations` 45 → 42。
- 钉着旧位置的用例随改：`rfc483-human-gate-badge-read-model-boundary`（task-execution 的装配根交出的是 `bindTaskGateOpenCondition`）；直接调用列表页
  构造函数、任务列表投影、生命周期投影与徽标条件的用例补上片段入参（取自 resource-catalog 的 infrastructure）。
- 新增 `tests/rfc567-workflow-name-fragment-binding-boundary.test.ts`，登记 guard-manifest：① 全部模块的 public 文件不导出 S9 退出门点名的四个片段
  （带正对照），resource-catalog 的装配根交出 `workflowNameExpression`；② 全部模块的源码不从 resource-catalog 取它（带负对照）；③ task-execution 的
  五处读模型用入参里的片段，bootstrap 从装配根取并交入；④ 编译期断言：resource-catalog 的实现就是 task-execution 声明的类型，绑定后的徽标条件就是
  collaboration 的绑定里那一格的类型。
- 行为：片段的结果由 `rfc395-a7-owner-queries` 覆盖（两种数据库）；五处读模型的结果由既有的列表页对拍、任务列表路由、WS 投影与徽标计数用例覆盖。

## 5. 取舍（可推翻）

1. **片段作为入参，而不是由 task-execution 自己再写一份**：按 id 取工作流名要读 resource-catalog 的表与“目录里可见”的谓词，是它的事实；RFC-483 对另
   三个片段就是这样处理的（owner 实现、装配期交入、联合语句归读模型）。
2. **不拆成两条语句**：列表页与任务列表路由都有查询条数预算（工作流名与行同一次查询取回），片段必须留在同一条语句里。
3. **位置入参紧跟 `db`**：列表页的构造函数一律以 `db` 开头，片段与句柄一起决定“在哪儿取名字”，放在它后面；可选入参仍在末尾。
4. **`taskGateOpenCondition` 用绑定函数造出**：它的签名是 collaboration 的绑定里定好的四个入参，片段不该塞进去；模块外没有别的读者。
5. **与另两个查询工厂分开做**：它们的消费方是另外七个文件、另一批用例构造点；这一步只处理退出门点名的片段。

## 6. 失败模式

- **resource-catalog 改了片段的签名**：bootstrap 的两处交接与 RFC-567 用例的编译期断言报类型错误。
- **有人把片段重新从 public 交出，或 task-execution 重新从 resource-catalog 取它**：RFC-567 用例 ① ② 与 `PUBLIC_SURFACE_DEBT` 的精确比对同红。
- **装配时漏交**：入参必填，`tsc` 报错。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：片段的实现留在 resource-catalog 的 infrastructure；task-execution 在 infrastructure 的入参里声明依赖，类型在它自己的文件里。**C11**：
  resource-catalog 的 public 撤 1 个符号。**C12**：RFC-567 用例覆盖全部模块的 public 文件与源码、五处读模型与两处结构绑定。**C13**：public 类型偏差
  45 → 42，其余计数不升；目标 DAG 不变。
- **本 RFC 承担的演进**：S9 退出门“四个 SQL 片段不再从任何 `public/*` 导出”成立。
- **留下的债**：resource-catalog 的两个查询工厂与 `IntentSkillArtifactOwner`（3 条）、`repositoryScopeExistenceReads`（1 条）与其余 38 条。
