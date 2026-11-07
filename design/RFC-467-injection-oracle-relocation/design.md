# RFC-467 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`RC/` = `S/modules/resource-catalog/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：facade 清仓——consumer 归零后删除；只剩用例在用的生产代码离开生产树（RFC-466 先例）。
- 不新增任何 context 边或跨 context 内部文件对：迁出的代码进用例树（用例可取任意内部文件）；resource-catalog 的适配器改取的是本 context 的文件。

## 1. 预言一族迁入用例树

| 原文件                                                      | 去处                                                | 说明                                                        |
| ----------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `TE/infrastructure/legacyTaskExecutionInjectionResolver.ts` | `T/helpers/legacyTaskExecutionInjectionResolver.ts` | 原样迁移；import 见下                                       |
| `S/services/agentDeps.ts`                                   | `T/helpers/agentDeps.ts`                            | 原样迁移                                                    |
| `S/services/mcpClosure.ts`                                  | `T/helpers/mcpClosure.ts`                           | 原样迁移                                                    |
| `S/services/pluginClosure.ts`                               | `T/helpers/pluginClosure.ts`                        | 原样迁移                                                    |
| `S/services/skillBootVerify.ts`                             | 删除                                                | `export *` of `RC/infrastructure/legacy/skillBootVerify`    |
| `S/services/skillIdentityPaths.ts`                          | 删除                                                | `export *` of `RC/infrastructure/legacy/skillIdentityPaths` |

预言的 import 改为：三个实现取同目录 helper；`isSkillInjectableThisBoot` / `skillFilesRel` 取 `RC/infrastructure/legacy/` 定义处；原先经策略束取的
`rowToMcp` / `rowToPlugin` 改取 `RC/infrastructure/mcpPersistence#mcpFromPersistenceRow` / `RC/infrastructure/pluginPersistence#pluginFromPersistenceRow`
（策略束原本就是这两个函数改名转出）。其余 import（`services/runtime/*`、`services/execution/resourcePolicy`、resource-catalog / task-execution
的 public 与 shared）不变。

用例：取预言的 5 个（`rfc223-pr6`、`rfc282-b2`、`scheduler-{plugin,mcp}-preload`、`scheduler-depends-closure`）、取三个实现的
（`agent-depends-on-save`、`mcp-end-to-end`、`mcp-closure`、`plugin-closure`、`rfc271-runtime-closure-refs`、`rfc284-batchc-resource-dedup`）与两个
helper（`legacyInjectionAgentLookup`、`mcpServiceBinding`）改取 `T/helpers/`；取两个 facade 的（`rfc223-pr6`、`rfc282-b2`）改取定义处。
TE 两处文档注释（`application/ports/taskAgentRun.ts`、`infrastructure/local/nativeTaskAgentRunOptions.ts`）里的「see services/mcpClosure /
pluginClosure」改指用例 helper。

## 2. 策略束只留外部策略

- `RC/infrastructure/aggregateAdapters/taskExecutionResourceSnapshots.ts` 的 `TaskExecutionResourceDependencies` 去掉 `assertNotBuiltin`、
  `isSkillInjectableThisBoot` 与 `skillFilesRel`（后者从未被读），只剩 `findManagedInjectionNameConflict`、`formatManagedInjectionNameConflict`、
  `pluginDisabledErrorCode`、`pickCallTarget`；适配器两处调用改为直接取 `RC/domain/systemResources#assertNotBuiltin` 与
  `RC/infrastructure/legacy/skillBootVerify#isSkillInjectableThisBoot`（同一个函数，调用参数不变）。
- `S/services/execution/taskExecutionResourceDependencies.ts` 只留这四个字段与它们的 import（`services/runtime/injectionIdentity`、
  `services/execution/resourcePolicy`、shared）；文件头改写为现状。
- 手写这份束的用例（若有）随之去掉多余字段。

## 2a. 失去模块外读者的 public 符号（G4）

集中验证里采架构报告，未被消费的 public 符号 322 → 323：resource-catalog `public/queries#validateAgentDependencies` 唯一的模块外读者是
`services/agentDeps`（只给预言用），随预言迁走后没有生产消费方。按 RFC-294 design §3.3 收回：`public/queries` 去掉这一行转出，用例 helper
`agentDeps` 与 `rfc395-a5-reference-ports` 改取定义处 `RC/application/agents/agentDependencyValidation`；resource-catalog 自己的 agent 应用
本来就直接取它。

## 3. 精确清单与账本

- RFC-376 结构守卫：不可达生产文件基线去掉六条，`export-star-barrels` 基线去掉两个 facade，后继登记随之改。
- RFC-345 的 facade 退役 / classic facade / MCP·插件 provider-neutral 用例里点名这几个文件的条目、RFC-454 的余下转出、RFC-292 来源锁、
  RFC-349 执行外围用例、技能启动校验用例与 RFC-395 表归属债务夹具中读这些路径的断言，按实测改指或销账。
- 架构报告 legacy owner 表去掉删除 / 迁出的文件。
- `architecture/commons-debt.json` 的 `R1` 按实测销账（预期 86 → 79）；guard-manifest 刷新改到的守卫文件行数。

## 4. 用例

- **新用例** `T/rfc467-injection-oracle-relocation.test.ts`：六个文件不在 src、src / 用例 / 脚本零 import 两个 facade 与三个迁出的 `services/`
  文件（census AST，别名与相对路径都认，带负对照）；预言与三个实现在 `T/helpers/`；策略束与 resource-catalog 端口只剩四个外部策略字段，适配器
  直接取 resource-catalog 自己的两个函数（源码锚点，且策略束对象的键集合逐个相等）。
- 受影响用例改 import（§1），其余断言不动。

## 5. 留下的债

- integration 触发器资源快照适配器仍注入 `assertNotBuiltin`（另一份束）。
- `services/execution/taskExecutionResourceDependencies.ts` 余下依赖在 `services/` 与 shared，随执行层归位。
- 预言与三个实现是否退役，留给后继 RFC（逐条核对其覆盖是否已由活实现的用例承担）。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §4；P0 变异 lane 两引擎各 17 阶段。
