# RFC-584 RFC-370 收口后的不可达生产文件：契约用例专用的兼容入口迁入 `tests/helpers`，过时的 Intent 维护副本删除（RFC-294 S11 余项）

- **状态**：Done（2026-11-25，落地 `dcbb373c3`，补正 `11255a537`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」，2026-11-25「继续」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；
  不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) S11 的不可达生产文件计数与 design §3 的层规则；承接
  [RFC-375](../RFC-375-backend-dead-code-sweep/proposal.md)（死代码清扫）留给“RFC-370 收口”的文件，做法沿用
  [RFC-491](../RFC-491-te-runtime-family-decoupling/proposal.md) / RFC-492（只供契约用例的兼容实现迁入 `tests/helpers/`）。

## 1. 背景

架构报告的 `unreachable-production-files` 是 15：生产入口 import 不到、只有用例在用的生产文件。`rfc376-structural-guards` 给每个文件登记了后继。
其中 8 个登记的后继是“RFC-370 收口”，而 [RFC-370](../RFC-370-crewstation-hosted-deployment/proposal.md) 已于 2026-10-19 Done：

| 文件                                                                        | 内容                                                        | 用的人   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| development-automation `infrastructure/actionWorkspace.ts`                  | 本机兼容入口：把 application 的工作区物化与本机效果拼在一起 | 4 个用例 |
| development-automation `infrastructure/pipelineEvidenceImport.ts`           | 本机兼容入口：流水线证据导入                                | 1 个用例 |
| development-automation `infrastructure/verificationRunner.ts`               | 本机兼容入口：验证配置运行                                  | 2 个用例 |
| event-center `infrastructure/customEventObserverProgram.ts`                 | 兼容入口：自定义事件观察程序                                | 1 个用例 |
| task-execution `composition/systemAgentRun.ts`                              | 兼容入口：按选定的准备跑系统代理                            | 1 个用例 |
| resource-catalog `infrastructure/mcpDiagnosticsEffects.ts`                  | 一跳转出：本机 MCP 诊断效果的旧地址                         | 1 个用例 |
| intent `application/maintenance.ts`                                         | RFC-503 之前的维护实现副本（直接读写文件系统）              | 1 个用例 |
| system-operations `infrastructure/crewstation/standbyExecutionAuthority.ts` | 托管执行权的待机实现                                        | 3 个用例 |

生产里早已各有正式路径（各模块 composition 选定的效果族、`application/maintenanceCommands.ts` 等）。

## 2. 目标

- **G1**：前五个原样迁入 `tests/helpers/`（只改 import 说明符与头注），用例改取新位置。
- **G2**：MCP 诊断的一跳转出删除，用例与按路径读源码的检查改取它指向的本机实现。
- **G3**：Intent 维护副本删除；`rfc234-turn-engine` 里用它的四条维护用例改测生产的维护命令（intent composition 交出的 `IntentMaintenanceCommands`）。
- **G4**：`unreachable-production-files` 15 → 8、`application-direct-effect-files` 1 → 0（那个副本是 application 层唯一直接做文件系统效果的文件）；
  其余计数不升；生产行为不变（这些文件生产入口本来就到不了）。

## 3. 非目标

- `standbyExecutionAuthority.ts`：执行权一族按既有约定暂缓，不在本 RFC 里动。
- 登记了别的后继的 7 个：`aw-inventory-dump.mjs`（运行时按路径加载的插件）、`postgresqlTaskLifecycleTransaction.ts`（RFC-359 明确保留的方言参照）、
  两个 `portableImportReferences`（后继 RFC-294 W4）、`submitTaskContinuation.ts`（RFC-328 控制门的直接断言）、`teaching/reconciliation.ts`（RFC-348
  保留的用例数据）、`legacy/workflow.yaml.ts`（随 resource-catalog 的 legacy 工作流一族退役）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：七个旧路径不存在，全部源码、用例与脚本不再取它们；五个迁走的文件与原文件只差 import 说明符与头注；生产源码不 import `tests/`。
- **AC-2**：生产行为不变；改取新位置的用例照旧通过；`rfc234` 的四条维护用例对生产命令通过（断言的业务结果不变：孤儿轮次的处置、按启动快照恢复、
  草稿目录的清理与保留）。
- **AC-3**：`unreachable-production-files` 上限 15 → 8、`application-direct-effect-files` 上限 1 → 0；其余计数不升；`rfc376` 的两份基线与后继表、
  `rfc521` 的分类表、`rfc282` 的检查清单随改；新增 RFC-584 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
