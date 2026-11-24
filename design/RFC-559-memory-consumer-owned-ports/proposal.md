# RFC-559 task-execution 与 collaboration 不再取 memory 的 public：记忆注入与蒸馏入队改为 consumer 自有端口（RFC-294 S9 第十四步）

- **状态**：Done（2026-11-23，落地 `83b179ac0`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §3.1（目标 DAG：memory → task-execution、memory → collaboration
  是 offered 边，反向不画；`TaskMemoryInjectionPort` 是 task-execution 自有、memory 实现的 required 端口）与 design §14“DAG 外的 offered 边 → 0”；做法同
  [RFC-558](../RFC-558-webhook-ingress-event-center-port/proposal.md)（consumer 自有端口，bootstrap 用 provider 交出的同一个对象绑定）。

## 1. 背景

`off-dag-offered-file-context-pairs`（44 条）里有 9 条是 task-execution / collaboration 取 memory 的 public，方向与目标 DAG 相反：

| 文件                                                                                                           | 取的 memory public                      |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| task-execution `application/ports/taskAgentRun.ts`                                                             | `MemoryInjectionQueries`、`ScopeBudget` |
| task-execution `composition/taskEngineRuntimeOptions.ts`、`infrastructure/taskExecutionRuntimeParticipants.ts` | `MemoryInjectionQueries`                |
| task-execution `composition/agentRunDistillObserver.ts`                                                        | `MemoryDistillEnqueuer`                 |
| collaboration 五个文件（`public/commands.ts`、`application/taskFeedback.ts` 与 clarify 的三个装配文件）        | `MemoryDistillEnqueuer`                 |

目标 DAG 早已把记忆注入写成 task-execution 自有的 `TaskMemoryInjectionPort`（memory 的注释也这么说），代码里却没有这个类型。task-execution 只用
注入查询的两个方法；蒸馏入队两边各只调一次 `enqueue`，collaboration 只读回 `jobId`。

## 2. 目标

- **G1**：task-execution 在 `application/ports/taskMemoryInjection.ts` 声明 `TaskMemoryInjectionPort`（`injectForRun` 与 `loadFirstAttemptSnapshot`）
  与 `TaskMemoryInjectionBudget`，在 `application/ports/taskMemoryDistill.ts` 声明 `TaskMemoryDistillPort`；四个文件改用它们。
- **G2**：collaboration 在 `application/ports/taskFeedbackMemoryDistill.ts` 声明 `CollaborationMemoryDistillPort`；五个文件改用它。
- **G3**：bootstrap 照旧交 memory 的注入查询与蒸馏命令（结构上满足这些端口，交接处由编译器检查）；类型只取 shared 合同。
- **G4**：DAG 外的 offered 边 44 → 35；随之失去最后一个外部消费方的 memory public 符号一并撤出（未消费的 public 符号保持 0）；精确清单与减速带
  随之降低，其余计数不升。
- **G5 结局不变**：同一个对象、同样的调用，记忆注入、首轮快照与蒸馏入队的行为不变。

## 3. 非目标

- 其余 35 条 DAG 外 offered 边；memory 自己的 public 合同（除撤出失去消费方的符号外不动）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 与 collaboration 的生产文件不再取 memory；三个端口由它们自己声明。
- **AC-2**：行为不变；memory 的对象满足端口由编译器检查（新用例的编译期断言与 bootstrap 的交接处）。
- **AC-3**：DAG 外 offered 边 44 → 35，精确清单（`rfc376-structural-guards`、`rfc294-review-offered-edge-dag`）与 `counts.json` 随之更新；失去消费方的
  memory public 符号撤出、读它们的用例随改；新增 RFC-559 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
