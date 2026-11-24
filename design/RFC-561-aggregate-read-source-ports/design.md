# RFC-561 技术设计

落在 system-operations 与 intent（聚合方自有端口）两个 bounded context 的 application 层；五个来源 context 只把失去模块外读者的类型从 public 撤回
模块内；bootstrap 不改代码。另改两份精确清单、`architecture/counts.json`、七处钉着旧位置的用例与清单，新增一个 RFC-561 用例。数字取 HEAD
`c974e28eb`。不改行为。

## 1. 改动

| 位置                                                                 | 做法                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system-operations `application/ports/systemOverviewSources.ts`（新） | 五个来源端口与汇总的 `SystemOverviewSources`：`load(requester)` 返回六类资源计数、`countCachedRepositories()`、`countScheduled(requester)`、记忆的 `queries.list` / `queries.filterVisible`、任务的 `load({ actor, since })`；类型只取 shared 与 identity-access 的 public |
| system-operations `application/overview.ts`                          | `composeSystemOverviewQuery` 的入参改为 `SystemOverviewSources & { now? }`；函数体一字不动                                                                                                                                                                                 |
| intent `application/ports/platformInventorySources.ts`（新）         | `IntentDevelopmentConfigInventoryQueries`（五种配置各一个 `list(authority)`，行只写清单读的字段）与 `IntentDigitalEmployeeInventoryQueries`（`listVisibleRows(type, authority)`）                                                                                          |
| intent `application/platformInventoryParticipant.ts`                 | 依赖的两个字段改用上面两个端口；函数体只换了 `developmentRows` 的行类型                                                                                                                                                                                                    |
| resource-catalog                                                     | `ResourceCatalogOverviewCounts` / `ResourceCatalogOverviewQuery` 从 `public/queries.ts` 挪到产出它的 `application/resourceCatalogOverview.ts`                                                                                                                              |
| source-control                                                       | `RepositoryOverviewQueries` 撤出 `public/queries.ts`，形状写在 `composition.ts` 的 `RepositoryWorkspaceOperations.overviewQueries` 上                                                                                                                                      |
| integration                                                          | `public/queries.ts` 只有一行转出 `IntegrationOverviewQueries`，整份删除（类型仍在 `application/ports/scheduledTaskPersistence.ts`）                                                                                                                                        |
| task-execution                                                       | `TaskOverviewQuery` 从 `public/queries.ts` 挪到 `application/ports/taskOverviewQuery.ts`，实现与装配改从那里取；`composition/taskOverview.ts` 不再转出这个类型                                                                                                             |
| digital-employee                                                     | 平台清单的三个类型从 `public/participants.ts` 挪到 `application/ports/platformInventory.ts`，owner adapter 改从那里取                                                                                                                                                      |

bootstrap 交的仍是 `composeResourceCatalogOverviewQuery(db)`、`repositoryWorkspaceOperations.overviewQueries`、`scheduledTaskRuntime.overview`、`memoryCatalog`、
`taskExecutionProvider.overview`、`developmentConfigOperations` 与 `digitalEmployee.platformInventory`：入参更宽、返回更具体，结构上满足七个端口。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 7 条；
  `counts.json` 33 → 26。
- 钉着旧位置的用例与清单随改：`rfc349-resource-catalog-provider-contributions`（计数模型的声明处）、`rfc517-module-root-runtime-logic-out-boundary`（owner
  adapter 的 import 清单）、`rfc503-intent-use-cases-out-of-composition-boundary`（新文件的依赖面不再含 development-automation 与 digital-employee 的
  public，负对照同步）、`rfc349-intent-platform-inventory-composition` 与 `rfc359-w21-task-overview-prepared-counts`（类型的出处）、
  `rfc305-architecture-lock`（取 identity-access 合同的文件清单：两个类型随声明搬了家，两份新端口各取一次 authority 类型）、RFC-310 的
  `os-architecture-manifest.json`（digital-employee 的外部依赖清单销去 intent 那一条）。
- 新增 `tests/rfc561-aggregate-read-source-ports-boundary.test.ts`，登记 guard-manifest：① system-operations 全部源码取别的业务 context 的只剩
  `composition.ts` 的备份准备参与者（authority 类型入口除外，带负对照）；② intent 全部源码不取 development-automation 与 digital-employee；③ 两份端口只取
  shared、identity-access 的 public 与本模块；④ 编译期断言：七个 owner 的对象可以赋给端口；⑤ 撤出的类型不在 public、integration 的 `public/queries.ts` 已删。

## 3. 失败模式

- **某个 owner 的查询改了签名**：bootstrap 交接处与新用例的编译期断言都会报类型错误。
- **聚合重新按名字取来源 context**：新用例 ① / ② 与两份精确清单同红。

## 4. 取舍（可推翻）

1. **聚合方自有端口、bootstrap 结构绑定，而不是让五个 owner 各加一个指向 system-operations 的指定 adapter**：owner 的对象已经满足端口；加 adapter 要在目标
   DAG 上新画五条指向 system-operations 的虚线边，而 RFC-294 design §3.4 把“跨业务统计”列为 system-operations 不跨界的内容——总览聚合将来可能搬家，
   端口归聚合方、不在总纲上留边，搬家时只带走一个端口文件与一个应用文件。
2. **不把聚合搬出 system-operations**：能合法取五个 context 的只有 bootstrap 与入站层，前者不放业务判断，后者是待收的横向层（CLAUDE.md 禁止再往
   `routes/` 加跨域耦合）；归属需要单独的决定，本 RFC 不预设。
3. **权限判断原地不动**：`repos:read`、`memory:read`、`tasks:read:*` 三个判断仍在聚合里，资源与定时任务的判断仍在各自 owner 里，与改动前逐字相同。
4. **端口只写聚合用到的方法与字段**：记忆只用 `list({ status: 'approved' })` 与 `filterVisible`；开发配置的行只写清单读的 `id / name / publishedRevision`
   与三个可选展示字段。
5. **失去读者的 public 类型撤回模块内，而不是留着**：未消费的 public 符号门保持 0；类型各回到产出它的地方（应用用例旁、模块内端口、装配输出的形状）。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口归聚合方的 `application/ports`，只取 shared 与 identity-access 的 authority 类型。**C11**：system-operations 与 intent 的 public 不变；五个来源
  context 的 public 收窄 8 个符号（resource-catalog 2、source-control 1、integration 1、task-execution 1、digital-employee 3），integration 的 `public/queries.ts`
  删除。**C12**：RFC-561 用例覆盖两个 context 的全部源码、两份端口、七处结构绑定与撤出。**C13**：DAG 外 offered 边 33 → 26，其余计数不升；目标 DAG 不变。
- **留下的债**：总览聚合仍在 system-operations（design §3.4 的归属未决）；记忆来源仍由聚合拼 `list` + `filterVisible`；system-operations `composition.ts` →
  source-control 的备份准备参与者一条 DAG 外边。
