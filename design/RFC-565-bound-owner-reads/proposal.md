# RFC-565 任务知识、触发与仓库身份的读由 bootstrap 交入：裸句柄的读撤出 task-execution 与 source-control 的 public（RFC-294 S9 第二十步）

- **状态**：Done（2026-11-24，落地 `ff3442970`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan S9 范围第 2 项（清偿 `PUBLIC_SURFACE_DEBT`：“收裸 db 句柄的
  查询工厂换成 owner 提供的业务查询”，SQL 片段撤出 public）与 design §3.2（public 合同不携带持久化句柄与 drizzle 类型）；做法沿用
  [RFC-483](../RFC-483-human-gate-badge-read-model/proposal.md)（片段撤出 public、经装配期绑定交入）与
  [RFC-485](../RFC-485-te-row-query-bindings/proposal.md)（bootstrap 在根句柄上建好闭合的读、交给消费方）。

## 1. 背景

`PUBLIC_SURFACE_DEBT`（56 条）里有 18 条是“public 交出的函数签名里带着持久化句柄或 drizzle 类型”。其中 11 条属于下面七个符号——它们都是 owner
的读，消费方拿自己手里的 db 句柄去调：

| owner / public 入口                  | 符号                                              | 清单条数 | 模块外的消费方                                                  |
| ------------------------------------ | ------------------------------------------------- | -------- | --------------------------------------------------------------- |
| task-execution `public/queries`      | `createTaskKnowledgeQueries(db)`                  | 1        | memory 的注入读存储与蒸馏工作存储                               |
| task-execution `public/queries`      | `listNodeEventContents(db, ids)`                  | 1        | memory 的蒸馏工作存储                                           |
| task-execution `public/queries`      | `createTaskTriggerQueries(db)`                    | 1        | integration 的 Webhook 派发持久化、投递读模型、终态工作区归属   |
| task-execution `public/queries`      | `nonTerminalTaskExists(db, 列)`（SQL 片段）       | 3        | integration 的 Webhook 触发记录保留清理（同一条语句里的子查询） |
| source-control `public/queries`      | `existingRepositoryIds(db, ids)`                  | 1        | memory 的注入读存储                                             |
| source-control `public/queries`      | `repositoryExistsExpression(db, 列)`（SQL 片段）  | 3        | task-execution 的任务知识读（蒸馏范围那一条语句里的子查询）     |
| source-control `public/participants` | `readHostedWorkspaceOwnerForBusinessTask(db, id)` | 1        | task-execution 的托管恢复选择                                   |

这些消费方都由各自模块的装配函数在根句柄上构造（没有一处拿事务句柄去调），所以“消费方自己用句柄造 owner 的读”并不必要：bootstrap 本来就在同一个
句柄上为 memory 建好了 task-execution 的节点运行读（RFC-485）。

## 2. 目标

- **G1**：七个符号撤出 task-execution 与 source-control 的 public；闭合的读类型（`TaskKnowledgeQueries`、`TaskTriggerQueries`）留在 public。
- **G2**：memory、integration 与 task-execution 的托管恢复选择改为从构造入参拿到已经建好的读；两个 SQL 片段作为函数引用交入（它们要拼进消费方
  自己的那条语句）。bootstrap 从两个 owner 的装配根取实现，在根句柄上建好再交入。
- **G3**：`listNodeEventContents` 并入 `TaskKnowledgeQueries`（`distillationEvents`）：它本来就是蒸馏消费的那组闭合投影之一。
- **G4**：`public-surface-deviations` 56 → 45；其余计数不升。
- **G5 结局不变**：同一个句柄、同样的语句与条数；只换“谁来构造”。

## 3. 非目标

- resource-catalog 的同类 6 条（`createAgentExecutionQueries`、`createWorkflowExecutionQueries`、`workflowNameExpression`、
  `IntentSkillArtifactOwner`）：消费方是 task-execution 的十个文件，另立 RFC。
- source-control 的 `repositoryScopeExistenceReads`（1 条）：它是铸仓库范围授权能力的入参，属于能力类合同，暂不动。
- 日志器类型、开放类型等其余 38 条。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：七个符号不再从任何 `public/*` 导出；task-execution 与 source-control 的装配根交出它们（或与之同句柄的闭合读）；全部模块的源码不再
  从 public 取它们。
- **AC-2**：行为不变；消费方的入参与 owner 的实现对得上，由编译器检查。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 删去 11 条，`public-surface-deviations` 56 → 45；新增 RFC-565 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
