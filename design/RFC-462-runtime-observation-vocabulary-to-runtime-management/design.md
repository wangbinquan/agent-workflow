# RFC-462 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`RM/` = `S/modules/runtime-management/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位；运行时驱动一族「先重画 task-execution ↔ runtime-management 的驱动接缝」。本 RFC
  只收接缝两侧都要用、又不属于接缝本身的观测词汇：它们是 runtime-management 的观测合同，与 RFC-370 已归位的 `NormalizedEventKind` 同处。
- task-execution → runtime-management 是目标 DAG 给的边，经 `public/participants` / `public/types` 取。

## 1. 去向

| 声明                                                                                                             | 新位置                                      |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `NormalizedTokenDelta`、`PersistedEventKind`、`NormalizedEvent`、`NormalizedEventData`、`SystemEventObservation` | `RM/application/ports/agentObservations.ts` |
| `DeclarationFace`、`RuntimeDriverCapabilities`                                                                   | `RM/application/ports/agentProtocol.ts`     |

声明与注释原样；`DeclarationFace` 的右边由 `keyof DeclaredManifestV1` 写成 `keyof DeclaredInjectionManifest`（前者是后者的别名）。
`RM/public/participants.ts` 导出这七个类型。`L/runtime/types.ts` 删去这七个声明，改为 `export type { … } from
'@/modules/runtime-management/public/participants'`（本文件里 `RuntimeDriver` 等仍用它们，另以 `import type` 取同一处）。

## 2. 消费方改指

- `TE/application/ports/agentExecution.ts`：`NormalizedEvent`、`SystemEventObservation` 改取 runtime-management `public/participants`。
- `TE/application/taskAgentRun.ts`：`NormalizedEvent`、`PersistedEventKind`、`StartupInventory` 改取 runtime-management
  `public/participants`；`RuntimeKind` 改取 `public/types`。
- `RM/application/ports/agentProtocol.ts`：`NormalizedEvent`、`SystemEventObservation` 取同目录 `agentObservations`，
  `RuntimeDriverCapabilities` 为本文件声明。
- `RM/application/ports/agentMaterialEvidence.ts`：`NormalizedEvent` 取同目录 `agentObservations`；会话捕获与系统代理会话清扫上下文
  仍取 `L/runtime/types`（非目标）。
- 驱动一族与 `L/execution/*` 仍经 `L/runtime/types` 的再导出取，import 不变。

## 3. 用例与锁

- **新用例** `T/rfc462-runtime-observation-vocabulary-to-runtime-management.test.ts`：七个声明在后端源码里只在 runtime-management 定义一次
  （`L/runtime/types.ts` 不再声明它们）；`L/runtime/types` 的再导出指向 runtime-management `public/participants`；四个改指的文件不再为这些名字取
  `L/runtime/types` / `L/runtime`（census AST，带负对照）；runtime-management 两个端口文件不取 `@/services/`（`agentMaterialEvidence` 余下的
  会话捕获 / 清扫上下文除外）。
- `commons-debt.json` 的 `R2` 4 条按实测销账；`rfc294-architecture-preflight` 的 public surface 偏差精确清单删去随之消失的条目（以架构报告
  实测为准）；guard-manifest 刷新行数。

## 4. 留下的债

- 驱动接口、执行上下文与驱动实现（proposal §3）；余下 7 条 `R2`。

## 5. 失败模式

- 类型漂移：声明原样搬迁，tsc（backend、shared、frontend）兜底；`L/runtime/types` 再导出保证驱动侧 import 不变。
- 精确清单失配：偏差 −N 让 `rfc294-architecture-preflight` 报 stale——按报告实测同批删去（RFC-461 的教训）。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
