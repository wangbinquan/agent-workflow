# RFC-588 任务路由按端点 owner 拆进 task-execution 与 workspace-insight 的 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第十批）

- **状态**：Done（2026-11-25，落地 `7ff4408d4`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（此前多次同样下达）：
  本会话按 RFC-294 总纲自行裁定落位（见 RFC-587 条目的“余下两批的落位”），不新增 DAG 边；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按
  路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2、§3 与 plan §4.6 W9-D；上一批见
  [RFC-587](../RFC-587-health-archive-feedback-routes-into-owner-modules/proposal.md)。

## 1. 背景

`routes/tasks.ts`（1065 行）是 task-execution 的任务路由，但其中七个端点是 workspace-insight 的能力：结构化 diff、变更叙述（读与触发）、文件内容、文件
符号、代码智能与调用目标。整份迁进 task-execution 不行——它们取 workspace-insight 的 public 类型，而 DAG 里只有 workspace-insight → task-execution，
反方向会成环；它们读配置（结构化 diff 的深度索引器与叙述设置）也只是 system-operations 配置里的几段。

## 2. 目标

- **G1**：任务路由迁入 `modules/task-execution/inbound/http/taskRoutes.ts`（除那七个端点外逐字不变）；七个端点连同深度配置的小函数逐字迁入
  `modules/workspace-insight/inbound/http/taskWorkspaceInsightRoutes.ts`，配置改为本绑定声明的中性形状，取任务的两个操作经 task-execution public 的
  `TaskRouteOperations` 的 `Pick`（DAG 上 workspace-insight → task-execution 是 offered-consumption）。
- **G2**：挂载函数经各自 composition 转出；`server.ts` 的 `tasks` 一步先挂任务路由、紧接着挂 workspace-insight 的绑定——`/api/tasks/:id/*` 的可见性
  中间件由任务路由先注册，七个端点照旧在它之后（Hono 按注册顺序组链）。
- **G3**：`legacy-horizontal-files` 59 → 58；未消费 public 符号保持 0；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `routes/agents.ts`、`workgroups.ts`（启动端点拆给 task-execution，下一批）；`registry` / `operationRoute` 与 identity-access 的路由；W5 的 `util/git`。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：旧路径不存在，全部源码、用例与脚本不再取它；两个新文件合起来与原文件只差 import、依赖接口的拆分与七个端点的位置（处理逻辑逐行不变）。
- **AC-2**：行为不变：可见性中间件在七个端点之前；任务、诊断、结构化 diff、变更叙述、文件内容 / 符号、代码智能的路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 59 → 58；未消费 public 符号保持 0（不再有别的模块消费的 public 符号随之撤回）；DAG 之外的边与跨 context
  内部文件对不增加；新增 RFC-588 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
