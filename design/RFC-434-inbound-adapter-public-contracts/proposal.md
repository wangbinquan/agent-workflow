# RFC-434 精确 public 入口与入站路由的第一批去深引（RFC-294 W4 B/D 第一步）

- **状态**：In Progress（2026-11-03 落档）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 余项 B / D 的第一步
- **前序**：RFC-294 S2 Done（[RFC-433](../RFC-433-explicit-presence-selections/proposal.md)）
- **落位**：入站路由（`routes/`）与 integration、memory、task-execution、development-automation 的 `public/` 精确入口；从 `composition` 搬走的类型落到
  本模块 `application/ports`。

## 1. 背景

RFC-294 W4 B / D 的退出门：入站适配器（`routes/`、`mcp/`、`ws/`）不 import `services/`，也不 import 模块 internal，只调用模块 public 的
command / query / operations。design §2 / §3 的约束：

- 跨模块只经 `public/{commands,queries,participants,events,types,operations}` 精确入口；
- `public/*` 不得 re-export composition 内部实现。

现状由已有账本精确跟踪，新增即红、减少须同步改账：

- `architecture/commons-debt.json` 的 `R1-inbound-module-internals`：210 条模块外 → 模块 internal 的边，其中 11 个路由文件 16 条。
- `rfc294-architecture-preflight` 的 `PUBLIC_SURFACE_DEBT` 与 `CROSS_CONTEXT_INTERNAL_DEBT`：全仓只有 3 个 public 文件不在精确入口集合里——
  `integration/public/mrTerminalControl.ts`、`memory/public/catalog.ts`、`task-execution/public/taskRoutes.ts`。指向它们的依赖被当作模块 internal，
  计入跨 context 内部边。

除上面两条约束外，还有三条已有的结构规则限制「把 application 合同直接从 public 导出」：

- `rfc400-collaboration-task-participants`：public 导出的签名闭包里不得出现遗留的 `Actor`（`@/auth/actor`）；
- `rfc294-architecture-preflight` 的能力归属规则：`RequestAuthority` 一类能力不得经 `public/types`、`public/events` 序列化；
- public surface 规则：类型闭包不得出现 `Partial`、函数类型等开放类型，也不得直接 import `platform/` 的实现类型（只减账本跟踪存量）。

调研与验证把 16 条路由深引分成两类：

- **本 RFC 收口**：依赖是 application 层已有的、类型闭包干净且不带遗留 `Actor` 的用例合同，或者是指向 3 个非精确 public 文件的边。
- **另立处理**：
  - 数字员工、事件中心的路由接收整个模块句柄；
  - `code.ts` 调用 code-capability 的 stage 合同纯函数（类型含 `ZodType`）；
  - 定时任务运行时由 `services/scheduledTasks` 的类型组成；
  - 能力模板与模板上游操作、任务目录查询、Webhook 投递运行时，它们的签名带遗留 `Actor`。按 RFC-294 §4.1，前两者分别属于 E8（code-capability
    并入 development-automation）与 E10（task-catalog「不接 full Actor」）。

## 2. 目标

- **G1 public 入口全部精确**：3 个非精确 public 文件按内容并入本模块的精确入口，全部导入方（生产与用例）改走新入口，文件删除。
- **G2 第一批路由去深引**：下列 8 条模块外深引改走精确 public 入口：
  - `routes/tasks.ts` 两条（任务恢复操作已在 TE `public/participants`；任务路由合同并入后在 `public/commands` / `types`）；
  - `routes/taskArchive.ts`、`routes/missionInputUploads.ts`（application 层合同由 public `commands` 导出）；
  - `routes/webhooks.ts`：`WebhookIngressPersistence` 从 composition 搬到 `application/ports`，由 public `commands` 导出；
  - `routes/webhookDeliveries.ts`、`services/webhook/webhookDispatch.ts`：终止控制并入 integration `public/participants`；
  - `routes/memories.ts`：记忆目录合同并入 memory 的精确入口。
- **G3 账本收敛**：
  - `R1-inbound-module-internals` 210 → 202；
  - 非精确 public 入口 3 → 0；
  - 跨 context 内部边 56 → 48；
  - public surface 债 −4 +1，新增的一条是 `TaskRouteOperations` 原有的函数类型债随文件搬家；
  - DAG 外 offered 边 54 → 55，原因见 §6 第 6 条。
- **G4 行为不变**：纯类型与导入路径调整，运行时对象、路由行为与 HTTP / MCP / WS 合同不变。

## 3. 非目标

- §1「另立处理」的 7 个路由文件 / 边：下一步 RFC 处理（与 E8、E10 协调）；
- 入站适配器对 `services/` 的 import（29 + 1 个文件）；
- 把 `routes/` 迁成各模块的 `inbound/` 绑定；
- public 类型闭包里的存量开放类型，照旧由 `PUBLIC_SURFACE_DEBT` 跟踪，不扩大；
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 精确入口**：`src/modules/*/public/` 下只有 6 种精确文件名；3 个非精确文件删除，生产与用例导入方全部改走精确入口。
- **AC-2 第一批路由**：G2 的 8 条边不再出现在 `R1-inbound-module-internals`；从 composition 搬出的类型位于本模块 `application/ports`，public 不 re-export
  composition，也不带遗留 `Actor`。
- **AC-3 账本**：G3 所列变化与实测一致，全部架构测试通过。
- **AC-4 回归**：typecheck、受影响路由与模块用例全部通过。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **路由自己声明依赖形状**：不在模块里新建「给路由用的端口」类型。路由参数由 public 的命令 / 查询类型组成，模块句柄在结构上满足它，装配层照旧传句柄。
2. **composition 里的接口搬到 `application/ports`**：它描述本模块提供的用例，属于 application；composition 改为导入。
3. **非精确 public 文件按内容拆进精确入口**，不保留转发文件：
   - 值类型进 `types`；
   - 查询接口与它要的权限包（`MemoryScopeAuthority`，含 `RequestAuthority`，按能力归属规则不进 `types`）进 `queries`；
   - 命令接口与任务路由合同（`TaskRouteOperations`，经 `./types` 引用归档事件读取器，不直接 import `platform/`）进 `commands`；
   - 终止控制等参与方进 `participants`；
   - memory 的组合句柄 `MemoryCatalogOperations` 进 `operations`，与已在那里引用它的 `MemoryOperations` 同处。
4. **签名带遗留 `Actor` 的合同不进 public**：把它们改成 identity-access 的权限类型是 E8 / E10 的工作，本 RFC 只收不改签名的那批。
5. **Webhook 入口的端点读取收窄**：`WebhookIngressPersistence.endpoints` 改为只含两个读方法的 `WebhookIngressEndpointReads`。原先 `Pick` 整个管理端口，
   会把管理端口的 `Partial` 补丁类型带进 public 闭包；端口在结构上仍满足它。
6. **两条 offered 边如实归类**：
   - 涉及的依赖是 system-operations 概览 → memory、task-execution 发布启动 → integration；
   - 它们早已存在，此前因为指向非精确 public 文件，被计作跨 context 内部边；
   - 入口精确后，它们如实归为 DAG 外的 offered 边，按已有格式登记（理由与清偿波次 W4-E）；
   - 同一批改动让跨 context 内部边减少 8 条。
