# RFC-519 设计：托管实现迁出组合层（二）

## 1. 现状（HEAD，源码实读）

| 文件（`packages/backend/src/modules/` 下）                       | 装配（留下）                                                                              | 托管实现（迁走，HEAD 行）                                                                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent/composition/crewstationArtifacts.ts`                     | `composeCrewStationIntentPluginRetention`；`composeCrewStationIntentArtifacts` 的三个字段 | 暂存引用校验与 `artifactContent` 的五个成员（17～25、30～40）                                                                                                                                 |
| `resource-catalog/composition/crewstationMcpDiagnostics.ts`      | `createCrewStationMcpDiagnostics`（取 `./mcpDiagnostics` 等三个组合文件）                 | 输入类型 `HostedInput`（28～43）、`createCrewStationMcpDiagnosticsEffects`（81～369）、备用实例跳过收敛的判断（63～70）                                                                       |
| `runtime-management/composition/crewstationRuntimeManagement.ts` | `composeCrewStationRuntimeManagement`（取 `./runtimeManagement`）                         | `HostedRuntimeCapabilitiesSchema`、`HostedRuntimeProfileMapping`、`createCrewStationRuntimeManagementEffects`（13～172）                                                                      |
| `system-operations/composition/crewstationDeployment.ts`         | 两个写入窗口 / 围栏工厂、迁移安装与系统选择的装配（取 `./applicationConfiguration`）      | 环境常量、类型、错误类与读取（50、72～181）；数据库配置与准备（183～231）；迁移安装的准备体（种子失败时关闭运行时，248～282）；控制客户端（286～296）；执行权失效时抛错的写入围栏（368～375） |

迁走部分的类型依赖：resource-catalog 的 effect 工厂按组合层的 `LocalMcpDiagnosticsCompositionInput` 取字段，这些字段都来自它继承的
`McpDiagnosticsEffectDependencies`（`infrastructure/local`）与 `McpDiagnosticsDependencies`（application），新位置改按这两个类型的交集取，形
状相同；system-operations 的写入围栏按 `CrewStationSystemSelections['mutationFence']` 定型，新位置改取 platform 的
`CrewStationMutationFence`。

钉着这些文件的锁：RFC-515 门的例外清单（4 条）与它的负对照（取清单第一条）；RFC-518 用例断言例外清单恰是这
4 个；`rfc294-review-offered-edge-dag` 与 `rfc376-structural-guards` 的跨 context 文件对账本里
`crewstationMcpDiagnostics.ts → runtime-management` 一条（随 `HostedInput` 的类型 import 迁走）；`rfc370-hosted-mcp-probe` 与
`rfc489-run-family-providers-boundary` 读组合文件原文（读的是留下的装配，按实测核对）。

## 2. 机制与落位

### D1 托管实现归 infrastructure（原样）

- **`intent/infrastructure/crewstation/intentArtifactContent.ts`**（新）：`createHostedIntentArtifactContent(resources)` 返回
  `IntentArtifactContentPort`，函数体是 HEAD 第 17～25 行的校验闭包与第 30～40 行的五个成员。
- **`resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects.ts`**（新）：`HostedInput`（改为导
  出）、`createCrewStationMcpDiagnosticsEffects`（HEAD 第 81～369 行；`LocalMcpDiagnosticsCompositionInput` 换成上述交集）与
  `reconcileWhenFenceHeld(fence, reconcile)`（函数体是 HEAD 第 64～69 行，`runtime.reconcileDurableIntents()` 换成参数 `reconcile()`）。
- **`runtime-management/infrastructure/crewstation/runtimeManagementEffects.ts`**（新）：HEAD 第 13～172 行逐字。
- **`system-operations/infrastructure/crewstation/deploymentEnvironment.ts`**（新）：HEAD 第 50、72～181 行逐字。
- **`system-operations/infrastructure/crewstation/deploymentDatabase.ts`**（新）：HEAD 第 183～231 行与第 286～296 行逐
  字；`prepareCrewStationMigrationInstallation(input)` 的函数体是 HEAD 第 248～282 行（外层闭包的
  `contract`、`environment`、`env`、`normalization` 改为参数）；`createHostedMutationFence(executionAuthority, control)` 返回 HEAD 第
  368～375 行的对象。

### D2 组合层只装配

- 4 个组合文件只留装配函数，改从新位置取工厂；它们今天导出的名字全部照旧导出（迁走的从新位置转出），bootstrap 与用例的 import 不改。
- system-operations 的 `composeCrewStationMigrationInstallation` 把 `prepare` 交给
  `prepareCrewStationMigrationInstallation`；`composeCrewStationSystemSelections` 的写入围栏改为
  `createHostedMutationFence(executionAuthority, control)`。
- resource-catalog 的 `createCrewStationMcpDiagnostics` 用 `reconcileWhenFenceHeld(input.fence, () => runtime.reconcileDurableIntents())`。

### D3 锁与计数

- RFC-515 门的例外清单清空、后继常量删除；`gate` 改为可传入例外清单，负对照用伪造的清单验证“清单内不报、陈旧要报”；清单长度断言为 0。
- RFC-518 用例的例外清单断言改为“不含 23 个已迁走的文件”（本 RFC 把清单清零）。
- 跨 context 文件对账本两处随路径改名；`rfc370-hosted-mcp-probe`、`rfc489` 按实测核对；`counts.json` 四个模块的上限收紧到实
  测；guard-manifest 登记 RFC-519 用例。

## 3. 清单（退出门）

| 新位置（`packages/backend/src/modules/` 下）                                | 声明并交出                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent/infrastructure/crewstation/intentArtifactContent.ts`                | `createHostedIntentArtifactContent`                                                                                                                                                                   |
| `resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects.ts`      | `HostedInput`、`createCrewStationMcpDiagnosticsEffects`、`reconcileWhenFenceHeld`                                                                                                                     |
| `runtime-management/infrastructure/crewstation/runtimeManagementEffects.ts` | `HostedRuntimeCapabilitiesSchema`、`HostedRuntimeProfileMapping`、`createCrewStationRuntimeManagementEffects`（另转出 `HostedRuntimeCapabilities` 类型）                                              |
| `system-operations/infrastructure/crewstation/deploymentEnvironment.ts`     | `CREWSTATION_DATABASE_URL_ENV`、`HOSTED_TASK_CONTRACT_VERSION`、`CrewStationDeploymentEnvironment`、`CrewStationEnvironmentError`、`readCrewStationDatabaseEnvironment`、`readCrewStationEnvironment` |
| `system-operations/infrastructure/crewstation/deploymentDatabase.ts`        | `crewStationDatabaseConfig`、`prepareCrewStationDatabase`、`prepareCrewStationMigrationInstallation`、`crewStationControlClient`、`createHostedMutationFence`                                         |

允许的形状：4 个组合文件不再声明这些名字（只转出），没有循环、switch、`try`、`throw`，不构造错误。

## 4. 用例

新增 `packages/backend/tests/rfc519-hosted-implementations-out-of-composition-boundary.test.ts`，登记 guard-manifest：

- ① 清单里的名字在全部生产文件（下限 3,000）、用例（下限 2,500）与 e2e 里只在各自的新位置声明；新文件恰好声明清单列的名字；4 个组合文件导出
  的名字与 HEAD 相同，转出的与新位置的是同一个对象。
- ② 4 个组合文件没有循环、switch、`try`、`throw` 与错误的构造；RFC-515 门的例外清单为空。
- ③ 五个新文件不取组合层；带负对照。
- ④ 行为：托管技能工件的引用校验与旧工件拒绝；备用实例（围栏不在手）跳过收敛、在手时收敛；写入围栏在执行权失效时抛原错误、在手时交出租约；迁
  移安装在种子失败时关闭运行时并重抛（其余行为由既有的 RFC-370 用例覆盖，它们经组合文件取同一批名字）。

## 5. 失败模式

- **走样**：按 HEAD 原文生成，按词法单元比对（只允许 import 与列明的闭包变量改为参数）。
- **漏改钉原文的锁**：按每段原文与每个名字全仓搜；集中验证带上全部 `tests/architecture/` 与记组合文件消费方的用例（RFC-518 的教训）。
- **例外清单清空后门的负对照失效**：负对照改为传入伪造的清单。

## 6. 取舍（可推翻）

1. **组合文件照旧转出迁走的名字**：4 个组合文件仍是这些装配的入口，消费方（bootstrap 与十来个用例）不改 import，迁移面最小；转出不是逻辑。
2. **两处闭包改参数**：迁移安装的准备体与写入围栏原是装配函数里的闭包，迁走时把捕获的变量改为参数，函数体逐字保留。
3. **resource-catalog 的输入类型按交集重写**：组合层的输入类型只是两个非组合类型的并，按交集取字段形状不变，不必把组合层的类型挪进
   application。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：托管实现落各模块 `infrastructure/crewstation/`；组合层只留装配。
- **C11**：public 不变。
- **C12**：RFC-519 用例覆盖全部生产文件、全部用例与 e2e 里的同名声明，另读 4 个组合文件与新位置；RFC-515 门覆盖全模块。
- **C13**：计数不升，触及的上限收紧到实测。

## 8. 本步承担的演进与留下的债

- **承担**：S10 组合层收口完成：RFC-515 门的例外清单清零，全部模块的组合层与模块根只装配。
- **留下**：组合层里装配期的选择分支按 S10 的分支上限处理；4 个组合文件对迁走名字的转出（消费方改从 infrastructure 或模块根取时一并删）。
