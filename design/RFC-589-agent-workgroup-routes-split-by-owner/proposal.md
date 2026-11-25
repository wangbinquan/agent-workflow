# RFC-589 代理与工作组路由按端点 owner 拆进 resource-catalog 与 task-execution 的 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第十一批）

- **状态**：In Progress（2026-11-25）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（此前多次同样下达）：
  落位按 RFC-587 条目里已裁定的“余下两批的落位”，不新增 DAG 边；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2、§3 与 plan §4.6 W9-D；上一批见
  [RFC-588](../RFC-588-task-routes-split-by-owner/proposal.md)。

## 1. 背景

`routes/agents.ts`（687 行）与 `routes/workgroups.ts`（301 行）是 resource-catalog 的 HTTP 绑定，但各有一个启动端点——`POST /api/agents/:id/tasks` 与
`POST /api/workgroups/:id/tasks`，鉴权点就是 `tasks:execute`——调 task-execution public 的启动操作（`AgentRouteTaskLaunchOperations` /
`WorkgroupRouteTaskLaunchOperations`）。DAG 上 task-execution → resource-catalog 是 offered-consumption，反方向只有 required-implementation：整份迁进
resource-catalog 就多出一条 resource-catalog → task-execution 的消费边，与已有的边成环。RFC-580 / RFC-581 正是因此把这两个文件留到了这一批。

## 2. 目标

- **G1**：两个文件除启动端点外逐字迁入 `modules/resource-catalog/inbound/http/agentRoutes.ts` 与 `workgroupRoutes.ts`；依赖接口去掉 `taskLaunch`，
  对 task-execution 类型的两条转出（没有读者）随之删掉。
- **G2**：两个启动端点逐字迁入 `modules/task-execution/inbound/http/agentTaskLaunchRoutes.ts` 与 `workgroupTaskLaunchRoutes.ts`；各带一份“读可见的代理 /
  工作组、看不见即 404”的小函数（与原来同码同文），依赖取 resource-catalog public 的查询与授权上下文类型（offered-consumption）。
- **G3**：挂载函数经各自 composition 转出；`server.ts` 的 `agents`、`workgroups` 两步各先挂 resource-catalog 的绑定、再挂对应的启动绑定，两者收同一个
  依赖对象。
- **G4**：`legacy-horizontal-files` 58 → 56；未消费 public 符号保持 0；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `routes/registry` / `operationRoute` 与 identity-access 的路由；`routes/taskCatalog.ts`；W5 的 `util/git`。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：两个旧路径不存在，全部源码、用例与脚本不再取它们；四个新文件合起来与原来两个文件只差 import、依赖接口的拆分、两个启动端点的位置与各自的
  可见性小函数（处理逻辑逐行不变）。
- **AC-2**：行为不变：代理、工作组的目录、详情、增删改、重命名、复制、ACL、闭包与启动的路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 58 → 56；未消费 public 符号保持 0（不再有别的模块消费的 public 符号随之撤回）；DAG 之外的边与跨 context
  内部文件对不增加；新增 RFC-589 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
