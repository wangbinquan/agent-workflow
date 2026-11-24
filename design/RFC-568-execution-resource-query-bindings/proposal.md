# RFC-568 resource-catalog 的两个执行资源查询工厂撤出 public，由 bootstrap 交给消费方（RFC-294 S9 第二十三步）

- **状态**：In Progress（2026-11-24）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan S9 范围第 2 项（“收裸 db 句柄的查询工厂换成 owner 提供的业务
  查询，tx-bound participant 的构造方式由后继 design 给出”）与 design §3.2；做法沿用 [RFC-482](../RFC-482-te-participant-bindings-small-families/proposal.md)
  （交工厂引用，每个调用点仍传自己手里的句柄，事务里的调用仍在事务里）与 [RFC-565](../RFC-565-bound-owner-reads/proposal.md)、
  [RFC-567](../RFC-567-workflow-name-fragment-binding/proposal.md)。

## 1. 背景

`PUBLIC_SURFACE_DEBT`（42 条）里还有两条是“public 交出的工厂收一个持久化句柄”：resource-catalog 的 `createAgentExecutionQueries(db)` 与
`createWorkflowExecutionQueries(db)`。它们的返回类型（`AgentExecutionQueries`、`WorkflowExecutionQueries`）是闭合的读合同，问题只在工厂的入参。
模块外的读者：

| 消费方                                                            | 用的工厂与方法           | 句柄                                         |
| ----------------------------------------------------------------- | ------------------------ | -------------------------------------------- |
| task-execution `infrastructure/taskRouteOperations.ts`（两处）    | 工作流 `summaries`       | 路由依赖里的 `db`                            |
| task-execution `infrastructure/fusionEngineTaskOperations.ts`     | 工作流 `documents`       | 依赖里的 `db`                                |
| task-execution `infrastructure/childExecutionLaunchOperations.ts` | 工作流 `summaries`       | **事务句柄**                                 |
| task-execution `infrastructure/taskSubjectQueries.ts`             | 工作流 `summaries`       | 构造时收到的句柄（collaboration 经绑定调用） |
| task-execution `application/actionExecutionRunners.ts`            | 工作流 `documents`       | 执行环境里的 `db`                            |
| task-execution `infrastructure/workgroupTurnsPersistence.ts`      | 代理 `readMany`          | **快照读事务句柄**                           |
| task-execution `infrastructure/dynamicWorkflowPersistence.ts`     | 代理 `read`              | 构造时收到的 `db`                            |
| intent `infrastructure/intentSqlPersistence.ts`                   | 代理 `portNames`         | runner 当前的句柄                            |
| knowledge-evolution `infrastructure/fusionRepository.ts`          | 工作流 `summaries`       | 入参里的 `db`                                |
| bootstrap `daemonHttpComposition.ts`                              | 代理（交给代码历史查询） | 根句柄                                       |

task-execution、intent、knowledge-evolution 消费 resource-catalog 都是目标 DAG 上的边；要改的只是“谁把工厂交到消费方手里”。

## 2. 目标

- **G1**：两个工厂撤出 resource-catalog 的 public，由它的装配根交出；闭合的读类型留在 public。
- **G2**：九处消费方从构造入参拿到工厂引用，调用点照旧把自己手里的句柄传进去（事务里的仍在事务里）；应用层的动作执行器不碰工厂，经执行环境的
  一个读取脚本定义，由环境绑定用工厂在环境自己的 `db` 上实现。bootstrap 从 resource-catalog 的装配根取工厂交入。
- **G3**：`public-surface-deviations` 42 → 40；其余计数不升。
- **G4 结局不变**：每次读用的句柄、语句与条数不变。

## 3. 非目标

- `IntentSkillArtifactOwner`（收事务句柄的产物 owner 合同）与 source-control 的 `repositoryScopeExistenceReads`：能力类合同，暂不动。
- 日志器类型、开放类型等其余 38 条。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：两个工厂不再从任何 `public/*` 导出；全部模块的源码不从 resource-catalog 取它们；resource-catalog 的装配根交出。
- **AC-2**：行为不变；消费方的入参与 owner 的工厂对得上，由编译器检查；事务里的读仍用事务句柄。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 删去 2 条，`public-surface-deviations` 42 → 40；新增 RFC-568 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
