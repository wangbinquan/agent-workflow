# RFC-567 工作流名片段撤出 resource-catalog 的 public，由 bootstrap 交给 task-execution 的任务读模型（RFC-294 S9 第二十二步）

- **状态**：Done（2026-11-24，落地 `f8dc493ec`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17、2026-11-24 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §5，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan S9 退出门（“`nodeRunStatusCondition`、`taskGateOpenCondition`、
  `taskGateVisibleCondition`、`workflowNameExpression` 不再从任何 `public/*` 导出”）与范围第 2 项（SQL 条件片段撤出 public）；做法沿用
  [RFC-483](../RFC-483-human-gate-badge-read-model/proposal.md)（片段由 owner 的装配根交出、经装配期绑定交入消费方）与
  [RFC-565](../RFC-565-bound-owner-reads/proposal.md)。

## 1. 背景

S9 退出门点名的四个 SQL 片段里，前三个由 RFC-483 撤出了 task-execution 的 public；还剩 resource-catalog 的 `workflowNameExpression(db, workflowId)`：
一个按工作流 id 取名字的同语句子查询（只取目录里可见的工作流），签名里带着持久化句柄与 drizzle 的 `SQL` / `SQLWrapper`（`PUBLIC_SURFACE_DEBT` 里占 3 条）。

读它的全在 task-execution（task-execution → resource-catalog 是目标 DAG 上的边，问题只在 public 合同带了 drizzle 类型），都是把“任务的工作流名”与
任务行放在同一条语句里取：

| 文件                                           | 用处                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `infrastructure/taskListPage/query.ts`（三处） | 任务列表页三条管线的 `workflow_name` 投影                                            |
| `infrastructure/taskListPage/filters.ts`       | 列表页搜索词在快路径上按工作流名匹配                                                 |
| `infrastructure/taskRouteOperations.ts`        | `GET /api/tasks` 的行投影                                                            |
| `infrastructure/taskLifecycleWsProjection.ts`  | 任务创建事件的 WS 投影                                                               |
| `infrastructure/taskGateQueries.ts`            | 人工门徽标计数的“任务有主体名”条件（`taskGateOpenCondition`，交给 collaboration 用） |

## 2. 目标

- **G1**：`workflowNameExpression` 撤出 resource-catalog 的 public，由它的装配根交出。
- **G2**：task-execution 在自己的 infrastructure 里声明这个片段的类型，五处读模型从入参拿到它；bootstrap 从 resource-catalog 的装配根取实现交入。
  片段照旧拼在 task-execution 自己的那条语句里。
- **G3**：`public-surface-deviations` 45 → 42；S9 退出门里“四个片段不再从任何 `public/*` 导出”这一项成立；其余计数不升。
- **G4 结局不变**：SQL 文本、参数次序与查询条数不变。

## 3. 非目标

- resource-catalog 另两个收句柄的查询工厂（`createAgentExecutionQueries`、`createWorkflowExecutionQueries`，消费方是 task-execution 的七个文件与
  intent、knowledge-evolution 各一个）：另立 RFC。
- 把工作流名改成任务行上的快照（那会改变改名后的显示，是产品行为变化）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`workflowNameExpression` 不再从任何 `public/*` 导出；全部模块的源码不从 resource-catalog 取它；resource-catalog 的装配根交出它。
- **AC-2**：行为不变；片段与 task-execution 声明的类型对得上，由编译器检查；列表页、任务列表路由、WS 投影与徽标计数的既有用例通过。
- **AC-3**：`PUBLIC_SURFACE_DEBT` 删去 3 条，`public-surface-deviations` 45 → 42；新增 RFC-567 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
