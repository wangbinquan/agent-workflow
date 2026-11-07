# RFC-461 application 层的 WS 推送改经端口、运行时类型改取 owner 的出口（RFC-294 W9-D 第八步）

- **状态**：Done（2026-11-06，落地 `bf61fc4a6`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-460](../RFC-460-shared-ref-resolvers-and-envelope-nonce/proposal.md)（调用目标选择、运行期引用解析与信封 nonce 出
  `services/`，`R2` 23 → 17）。
- **落位**：task-execution `application/ports/taskAgentMaterial.ts`（agent 运行的端口包）；memory `application/ports/distillWorkStore.ts`
  与 `infrastructure/memoryDistillWorkStore.ts`；runtime-management `application/ports/agentSessionEvents.ts`。

## 1. 背景

`R2`（模块的 application / domain / engine / public 取 `services/` 或 `ws/`）还剩 17 条。其中 6 条与运行时驱动一族的搬迁无关，只是
application 层直接推 WS，或者经 `services/` 转手取 owner 早已公开的类型：

- **WS 推送**（3 条）：task-execution `application/taskAgentRun.ts` 三处推同一个 `node.status: running` 的幂等 ping，直取
  `@/ws/broadcaster`；memory 蒸馏（`application/distill/memoryDistiller.ts`，候选记忆创建）与蒸馏调度（`application/distill/schedule.ts`，
  作业排队 / 开始 / 完成 / 失败）同样直取。task-execution 自己早有 `NodeStatusEvents` 端口（`application/ports/nodeExecutionSupport.ts`），
  代码宿主 / 人工门 / 分支激活的节点执行都经它推，由 composition 接 `infrastructure/nodeStatusEvents.ts`。
- **类型转手**（3 条）：runtime-management `application/ports/agentSessionEvents.ts` 取 `services/runtime/types` 的
  `NormalizedEventKind`——它本就定义在同模块的 `application/ports/agentObservations.ts`，`services/runtime/types` 只是再导出；memory
  `application/ports/distillWorkStore.ts` 取 `services/sessionEventSink` 的 `SystemAgentEventSinkV1`——runtime-management
  `public/participants` 已导出它，这个端口文件也已经取 runtime-management 的 public；memory 蒸馏取 `services/runtime/types` 的
  `RuntimeKind` 与 `SystemAgentOutputEvidence`——它们正是 memory 所用的 task-execution 系统代理运行合同（`SystemAgentRunFamily`）里请求的
  `protocol` 与结果的 `outputEvidence`。

## 2. 目标

- **G1 端口**：task-execution 的 agent 运行端口包（`TaskAgentRunPurpose`）加 `status: NodeStatusEvents`，`taskAgentRun` 三处 ping 改经它，
  各个端口包的构造处接 `infrastructure/nodeStatusEvents.ts` 的 `broadcastNodeStatus`；memory 的蒸馏工作端口（`MemoryDistillWorkStore`）加
  `events`（候选记忆与蒸馏作业两类消息），蒸馏与调度改经它，infrastructure 的工作存储用原来的两个 broadcaster 实现。消息载荷、频道与
  推送时机原样。
- **G2 类型取 owner 的出口**：`agentSessionEvents.ts` 改取同模块的 `agentObservations.ts`；`distillWorkStore.ts` 改取 runtime-management
  `public/participants`；memory 蒸馏的两个类型改为 task-execution 合同上的类型别名（`SystemAgentRunFamily['run']` 的 `protocol`、
  `PreparedSystemAgentRunResult['outputEvidence']`）。
- **G3 账本下降**：`R2` 17 → 11（task-execution 1、memory 4、runtime-management 1）；memory 的 application 层不再取 `services/` 与 `ws/`；
  `R1` 不变；不新增目标 DAG 之外的边、跨 context 内部文件对、off-DAG offered 文件对、`module-layer-violations` 与不可达生产文件；
  public surface 不变。

## 3. 非目标

- 余下 11 条 `R2`：task-execution `taskAgentRun` 取运行时驱动与三个执行助手（7）、task-execution `ports/agentExecution` 与 runtime-management
  两个端口取 `services/runtime/types` 的驱动类型（3）、intent `turnSession` 取 `services/sessionEventSink`（1）——都随运行时驱动一族
  （`services/runtime/**`）归位。
- memory infrastructure 取 `services/sessionEventSink` 的两处（infrastructure 不在 `R2` 的围栏里；改取 runtime-management public 会新增
  off-DAG offered 文件对），随运行时驱动一族一起处理。
- 安全相关改动。

## 4. 用户可见变化

无。WS 消息的频道、类型、载荷与推送时机不变。

## 5. 验收标准

- **AC-1**：`taskAgentRun`、memory 蒸馏与调度不再取 `@/ws/broadcaster`；三处 `node.status: running` 经端口包的 `status`，memory 的五处作业
  消息与候选记忆消息经工作存储的 `events`；`agentSessionEvents`、`distillWorkStore` 与 memory 蒸馏不再取 `services/runtime/types` /
  `services/sessionEventSink`。
- **AC-2**：架构计数按实测：`R2` 17 → 11（账本逐条相等），`R1` 不变；越界类计数不升，public surface 不变。
- **AC-3**：受影响用例（agent 运行的端口包构造、节点状态推送、memory 蒸馏 / 调度与 WS 频道、运行时观测类型）全部通过；新增 RFC-461 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **agent 运行复用 `NodeStatusEvents`，不另立端口**：代码宿主、人工门与分支激活的节点执行都经这个端口推 `node.status`（wrapper 的
   状态发布端口也落到同一个 `broadcastNodeStatus`），agent 运行只是又一个消费者；端口挂在已经「每项能力必填、构造不做 IO」的
   `TaskAgentRunPurpose` 上。
2. **memory 的 WS 通知随工作存储提供，不另加入参**：五处作业消息（排队、开始、完成、失败、重试排队）与候选消息都紧跟一次工作存储写入发出，入口函数
   （`enqueueDistillJob` / `retryFailedJob` / `distillTick` / `runDistill`）都已拿着工作存储；挂在端口上不改函数签名，infrastructure 的实现
   一直在，没有可选的回退分支。
3. **memory 蒸馏的两个运行时类型取 task-execution 合同上的别名，不直取 runtime-management**：memory → runtime-management 不是目标 DAG
   给的边，蒸馏文件直取会新增一对 off-DAG offered 文件对；而这两个类型的含义本来就是「系统代理运行族接受的协议」与「它返回的输出证据」。
