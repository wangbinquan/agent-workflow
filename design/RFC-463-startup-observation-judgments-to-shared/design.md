# RFC-463 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`SH/` = `packages/shared/src/`，
`RM/` = `S/modules/runtime-management/`，`TE/` = `S/modules/task-execution/`，`RC/` = `S/modules/resource-catalog/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位。启动核验与清单观测的判定是 shared 已有形状（声明清单、启动观测、核验结果、
  清单观测，RFC-280 / RFC-297 放在 `SH/schemas/`）上的纯函数，消费方横跨 task-execution 与 resource-catalog（目标 DAG 里两者互不相取，
  resource-catalog 也不取 runtime-management），归 shared——shared 是前后端共用的合同包，任何层都可取（RFC-458 / RFC-460 同一做法）。
- `EMPTY_RUNTIME_PROFILE` 是 runtime-management `public/types` 里 `RuntimeProfile` 的空值，归同处；task-execution → runtime-management
  是目标 DAG 给的边（task-execution 已有取 runtime-management public 的值边）。

## 1. 去向

| 声明                                                                                                                                                                                 | 新位置                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `L/execution/startupVerification.ts`：`declaredHasContent`、`verifyStartup`、`observationFromInventory`、`observationForVerification`、`ClaudeInitObservation`、`observationFromClaudeInit` | `SH/startupVerification.ts`  |
| `L/execution/inventoryObservation.ts`：`buildRuntimeInventoryObservation` 与私有助手                                                                                                | `SH/inventoryObservation.ts` |
| `L/execution/agentInjection.ts`：`EMPTY_RUNTIME_PROFILE`                                                                                                                            | `RM/public/types.ts`         |

声明与注释原样，只改这几处：

- 两个文件取 shared 的 import 改为包内相对路径（`./schemas/startupVerification`、`./schemas/runtimeInventory`、`./inventory`）；
- `startupVerification.ts` 对四个 shared 类型的再导出删去（shared 入口已从 `schemas/startupVerification` 导出它们）；
- 驱动能力：`SH/startupVerification.ts` 新增 `StartupObservationSource`（`'inventory-file' | 'init-event' | 'none'`）与
  `StartupObservationCapabilities`（`startupObservation`、`observationRequiresFreshRun` 两个只读字段）；`observationForVerification` 的
  `capabilities` 写成 `Pick<StartupObservationCapabilities, 'startupObservation'>`，`buildRuntimeInventoryObservation` 与私有
  `observedFacesOf` 写成 `StartupObservationCapabilities`（原为 `RuntimeDriverCapabilities`；判定只读这两个字段）；
- `inventoryObservation.ts` 的 `DeclaredManifestV1` 写成 `DeclaredInjectionManifest`（前者是后者的别名）；
- 文件头加一行迁移来由；`agentInjection.ts` 头注释「只 type-import shared 与 RuntimeProfile」随之写明 `EMPTY_RUNTIME_PROFILE` 的值取自
  零 import 的 runtime-management `public/types`。

`SH/index.ts` 导出两个新文件（紧跟它们依赖的两个 schema）。`RM/application/ports/agentProtocol.ts` 的 `startupObservation` 写成
`StartupObservationSource`（同一个联合类型）。两个 `L/execution/` 文件删除。

## 2. 消费方改指

- `TE/application/taskAgentRun.ts`：四个判定与 `StartupVerificationRecord` 改取 `@agent-workflow/shared`；`EMPTY_RUNTIME_PROFILE` 改取
  runtime-management `public/types`。
- `TE/infrastructure/crewstation/nativeMaterial.ts`：`EMPTY_RUNTIME_PROFILE` 改取 runtime-management `public/types`（其余注入助手仍取
  `L/execution/agentInjection`）。
- `RC/composition/crewstationMcpDiagnostics.ts`、`RC/infrastructure/local/mcpDiagnosticsEffects.ts`：判定与 `StartupObservation` 改取 shared。
- `L/execution/agentInjection.ts`：`EMPTY_RUNTIME_PROFILE` 删去，默认参数改取 runtime-management `public/types`。

## 3. 用例与锁

- **新用例** `T/rfc463-startup-observation-judgments-to-shared.test.ts`：两个旧文件不在、`S/`、用例、仓库根 `tests/` 与脚本零引用旧路径
  （census AST，带负对照）；每个迁出的函数在后端与 shared 源码里只有 shared 一处定义、shared 入口导出的就是它；`EMPTY_RUNTIME_PROFILE`
  只在 runtime-management `public/types` 定义、`agentInjection` 不再导出；`taskAgentRun` 不再取 `@/services/execution/`；编译期：
  `RuntimeDriverCapabilities` 可赋给 `StartupObservationCapabilities`，`startupObservation` 与 `StartupObservationSource` 双向相等。
- 改指的用例：`rfc280-startup-verification`、`rfc370-m2-startup-inventory`、`rfc297-inventory-column` 的 import；
  `rfc282-c0c2-runtime-fence` 读穷尽分支的文件改为 shared 的 `startupVerification.ts`；三个取 `EMPTY_RUNTIME_PROFILE` 的 RFC-370 用例。
- 账本：`commons-debt.json` 的 `R2` 4 条按实测销账，RFC-317 登记的两条 P3（EK-04、RT-09）的锚点改指迁入后的同一段代码（按内容重新
  定位行号）；`commons-manifest.json` 的这一公共内核改指 shared 的两个文件（owner / layer 按 shared 内核的惯例写成
  `shared-contracts` / `domain`）；`architectureReport.ts` 的 legacy 归属表删去两条；钉住「还剩下的」的用例与精确清单按全量守卫实测同批
  更新（RFC-461 的教训）；guard-manifest 按实测刷新（本 RFC 改到的守卫文件行数未变时不动）。
- 漏网的消费方：opencode 集成用例（`T/integration-opencode/rfc281-boundary.integration.test.ts`）也取 `EMPTY_RUNTIME_PROFILE`，一并改指。

## 4. 留下的债

- 余下 3 条 `R2`（`NOOP_HANDLE`、会话捕获 / 清扫上下文、`sessionEventSink`），都在驱动接缝上；`agentInjection.ts` 其余内容随驱动一族。

## 5. 失败模式

- 类型漂移：声明原样搬迁，tsc（backend、shared、frontend）兜底；能力参数只收窄到判定实际读的两个字段，调用方传入的
  `RuntimeDriverCapabilities` 结构上满足，编译期断言锁住两边的联合类型一致。
- shared 入口重名：迁入的导出名在 shared 与前端里都无同名（实测）。
- 前端打包：迁入的是不取 node 内建的纯函数，前端不 import 时被摇掉。
- 运行时环：`agentInjection` 改取的 `public/types` 零 import，不成环。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
