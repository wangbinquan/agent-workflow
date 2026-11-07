# RFC-465 会话捕获的持久化端口与请求合同归 runtime-management（RFC-294 W9-D 第十二步）

- **状态**：Done（2026-11-07，落地 `27ac7027a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-464](../RFC-464-live-capture-absence-and-intent-turn-sink/proposal.md)（无实时捕获按缺席处理、intent 自持轮次事件 sink 合同，
  `R2` 3 → 1）。
- **落位**：runtime-management `application/ports/runtimeSessionCapturePersistence.ts`（自 task-execution 迁入）、
  `application/ports/agentMaterialEvidence.ts`、`public/participants.ts`。

## 1. 背景

`R2`（模块的 application / domain / engine / public 取 `services/` 或 `ws/`）只剩 1 条：runtime-management 的材料证据端口
（`application/ports/agentMaterialEvidence.ts`）为会话捕获与系统代理的子会话清扫取 `services/runtime/types` 的三个形状——
`SessionCaptureContext`（端口的 `AgentSessionCaptureRequest` 就是它去掉四个本机位置字段）、`SystemAgentSessionSweepContext` 与
`SystemAgentSessionSweepOutcome`。

这三个形状不能原样搬进 runtime-management：`SessionCaptureContext.persistence` 是 task-execution 的端口
`RuntimeSessionCapturePersistence`（`application/ports/runtimeSessionCapturePersistence.ts`），而目标 DAG 里 runtime-management 不取
task-execution。同一个端口已经让 runtime-management 的实时捕获请求（`application/ports/agentLiveCapture.ts`）形成一条
runtime-management → task-execution 的跨 context 内部文件对（RFC-294 preflight 与 RFC-376 结构守卫的精确清单里各登记一次）；驱动的两个会话
捕获实现与 `services/runtime/types` 取它，各记一条 `R1`（commons-debt G-01，共 3 条）。

这个端口是驱动「把捕获到的子会话事件写到哪里」的合同：调用它的是运行时驱动（runtime-management 一族），实现它的是 task-execution（写自己的
`node_run_events`）。消费方拥有端口、实现方依赖消费方，正是 RFC-294 的依赖倒置做法，与 RFC-464 让 intent 声明自己实现的 sink 合同同理。
系统代理清扫的 sink 原本是 `SystemAgentEventSinkV1` 的结构副本，只因在 `services/runtime/types` 里命名它会成环；进了 runtime-management，
它就能直接取同一 context 里的合同。

## 2. 目标

- **G1 持久化端口归 runtime-management**：`RuntimeSessionCapturePersistence` 与 `RuntimeSessionCaptureEvent` 迁入 runtime-management
  `application/ports/runtimeSessionCapturePersistence.ts`（方法逐字不变），事件 kind 用 runtime-management 自己的词汇（持久化的观测 kind 加
  `stderr`、`subagent_capture_failed`），由 `public/participants` 导出；实时捕获请求、task-execution 的聚合持久化端口与实现、驱动的两个会话
  捕获实现改取它，task-execution 下的旧文件删除。
- **G2 捕获请求与清扫合同归 runtime-management**：`AgentSessionCaptureRequest`、系统代理清扫的请求与结果在 `agentMaterialEvidence.ts` 里直接
  定义（字段逐一与原来相同；清扫 sink 直接取 `SystemAgentEventSinkV1`），由 `public/participants` 按名导出；`services/runtime/types` 的捕获
  上下文改为在捕获请求上加四个本机位置字段，清扫上下文与结果直接取 runtime-management 的合同。驱动与本地材料证据的 import 不动。
- **G3 账本下降**：`R2` 1 → 0；`R1` 99 → 96（G-01 的 3 条）；跨 context 内部文件对 48 → 47；public surface 偏差不升；不新增目标 DAG 之外的边、
  off-DAG offered 文件对与 `module-layer-violations`。

## 3. 非目标

- 驱动一族（`services/runtime/**`）本身归 runtime-management infrastructure（下一步）。
- 驱动接口、执行上下文与驱动实现的行为。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`RuntimeSessionCapturePersistence` / `RuntimeSessionCaptureEvent` 只在 runtime-management 定义一次，task-execution 下的旧文件不在，
  `src/`、用例与脚本零引用旧路径；runtime-management 的 application / domain / engine / public 零取 `@/services/` 与 task-execution；
  `services/runtime/types` 不再取 task-execution，三个驱动侧形状由 runtime-management 合同给出。
- **AC-2**：架构计数按实测：`R2` 1 → 0、`R1` 99 → 96（账本逐条相等）；跨 context 内部文件对 48 → 47；public surface 偏差不升；越界类计数不升。
- **AC-3**：受影响用例（两个驱动的会话捕获、实时捕获、材料证据、系统代理运行、agent 运行、写原子性）全部通过；新增 RFC-465 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **端口归消费方**：驱动是端口的唯一调用方，task-execution 只是实现它（写自己的表）；端口留在 task-execution，runtime-management 就永远要反取
   task-execution。事件 kind 由 runtime-management 的观测词汇写出，用例编译期锁住它与 task-execution 落库的 kind 双向相等。
2. **捕获请求与清扫合同按名导出**：它们本来就是公共根 `AgentMaterialEvidence` 方法的参数与返回值（此前经 `services/runtime/types` 进入
   公共合同，检查器在那几处 forbidden import 止步、记 3 条偏差），按名导出不让新的开放类型穿过公共面；驱动侧因此能按名取用，与 RFC-462
   观测词汇的再导出同一做法。public surface 偏差按实测 96 → 94（那 3 条消失，清扫结果的 `unknown` 失败原因进入检查范围记 1 条）。
