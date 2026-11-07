# RFC-462 运行时观测词汇归 runtime-management（RFC-294 W9-D 第九步）

- **状态**：Done（2026-11-07，落地 `3229bcabb`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-461](../RFC-461-application-ws-push-through-ports/proposal.md)（application 层的 WS 推送改经端口，`R2` 17 → 11，余下全在运行时
  驱动一族）。
- **落位**：runtime-management `application/ports/agentObservations.ts`、`application/ports/agentProtocol.ts`、`public/participants.ts`。

## 1. 背景

`R2`（模块的 application / domain / engine / public 取 `services/` 或 `ws/`）余下 11 条全在运行时驱动一族。驱动合同
`services/runtime/types.ts`（912 行）把两类东西放在一起：

- **观测词汇**：驱动把 stdout 规范化成的事件（`NormalizedEvent` 及其 `NormalizedEventData`、`NormalizedTokenDelta`）、可落库的事件种类
  （`PersistedEventKind`）、系统事件观测（`SystemEventObservation`）与驱动的静态能力声明（`RuntimeDriverCapabilities`、`DeclarationFace`）。
  它们是闭合的数据类型，只依赖 shared 与 runtime-management 自己的 `NormalizedEventKind` / `TerminalResultObservation`（RFC-370 已把这两个
  种类放进 runtime-management 的 `agentObservations.ts`，`services/runtime/types` 只是再导出）。
- **驱动接口与执行上下文**：`RuntimeDriver`、各类 spawn 上下文与会话捕获上下文——带函数成员、日志器与 task-execution 的会话捕获持久化端口，
  是 task-execution ↔ runtime-management 驱动接缝的一部分。

task-execution 的 `application/ports/agentExecution.ts` 与 `application/taskAgentRun.ts`、runtime-management 自己的
`application/ports/agentProtocol.ts` 为了这几个观测词汇取 `services/runtime/types`（`taskAgentRun` 还为了 `RuntimeKind` 取
`services/runtime`，而 `RuntimeKind` 就定义在 runtime-management `public/types`）。

## 2. 目标

- **G1 归位**：七个观测词汇原样迁入 runtime-management——事件一族与系统事件观测进 `application/ports/agentObservations.ts`（与
  `NormalizedEventKind` 同处），驱动能力声明进 `application/ports/agentProtocol.ts`（与使用它的 `AgentInvocationProtocol` 同处）；
  `public/participants.ts` 导出它们。`services/runtime/types.ts` 删去这七个声明、改为从 runtime-management public 再导出（驱动与其余
  consumer 的 import 不变）。
- **G2 消费方改取 owner**：task-execution 的 `agentExecution` 端口与 `taskAgentRun` 改取 runtime-management `public/participants` /
  `public/types`；runtime-management `agentProtocol` / `agentMaterialEvidence` 端口改取同模块定义处。
- **G3 账本下降**：`R2` 11 → 7（task-execution 3、runtime-management 1）；`R1` 不变；public surface 偏差只降不升（迁入的都是闭合类型；
  `agentProtocol` / `agentMaterialEvidence` 的「forbidden type import `@/services/runtime/types`」偏差随之消失）；不新增目标 DAG 之外的边、
  跨 context 内部文件对、off-DAG offered 文件对与 `module-layer-violations`。

## 3. 非目标

- 驱动接口与执行上下文（`RuntimeDriver`、spawn / 会话捕获 / 系统代理会话清扫上下文）与驱动实现本身——它们带函数成员、日志器与
  task-execution 的持久化端口，进 runtime-management public 会抬 public surface 偏差，要先重画驱动接缝。
- 余下 7 条 `R2`：`taskAgentRun` 取 `NOOP_HANDLE` 与三个执行助手（`agentInjection`、`startupVerification` 的类型与值、
  `inventoryObservation`，共 5 条）、`agentMaterialEvidence` 取会话捕获 / 清扫上下文（1）、intent `turnSession` 取
  `services/sessionEventSink`（1）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：七个观测词汇只在 runtime-management 定义一次，`services/runtime/types` 再导出的就是它们；task-execution 的两处与
  runtime-management 的两个端口不再为它们取 `services/runtime/types`，`taskAgentRun` 不再为 `RuntimeKind` 取 `services/runtime`。
- **AC-2**：架构计数按实测：`R2` 11 → 7（账本逐条相等），`R1` 不变；public surface 偏差不升；越界类计数不升。
- **AC-3**：受影响用例（驱动事件解析、能力声明自检、agent 运行、运行时观测）全部通过；新增 RFC-462 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **只迁闭合的观测词汇，驱动接口留待接缝重画**：观测词汇是 runtime-management 的观测合同（种类已在那里），迁过去不带任何函数成员、日志器
   或别的模块的端口；驱动接口按 RFC-294 design §3.4 不能原样进 public（「进程句柄、vendor SDK 对象」不出 runtime-management），整体搬迁要
   先把 task-execution 用驱动的几处收成 runtime-management 的窄 participant，另立 RFC。
2. **`services/runtime/types` 留再导出，不逐个改驱动的 import**：驱动一族（opencode / claude 的事件、spawn、会话捕获等）随驱动接缝那一步
   整体归位，届时它们与这些类型同在 runtime-management；现在改它们的 import 是一次性的过渡改动。
3. **`DeclarationFace` 写成 `keyof DeclaredInjectionManifest`**：`services/execution/agentInjection` 的 `DeclaredManifestV1` 只是 shared
   `DeclaredInjectionManifest` 的别名；runtime-management 的 application 端口不取 `services/`。
