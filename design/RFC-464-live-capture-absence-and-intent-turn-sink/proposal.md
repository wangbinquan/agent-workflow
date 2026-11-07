# RFC-464 无实时捕获按缺席处理、intent 自持轮次事件 sink 合同（RFC-294 W9-D 第十一步）

- **状态**：Done（2026-11-07，落地 `aad1b4a76`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-463](../RFC-463-startup-observation-judgments-to-shared/proposal.md)（启动核验与清单观测的判定进 shared，`R2` 7 → 3）。
- **落位**：task-execution `application/taskAgentRun.ts`；intent `application/ports/intentSystemAgent.ts`、`application/turnSession.ts`。

## 1. 背景

`R2` 余下 3 条，都在驱动接缝上。其中两条不需要先重画接缝：

- **task-execution `taskAgentRun` 取 `services/runtime` 的 `NOOP_HANDLE`**：runtime-management 的 `AgentMaterialEvidence` 把实时子会话捕获
  声明为可选能力（`startLiveCapture?`，只有 opencode 有），合同注释写明「缺席即原意的不支持，调用方不替它造空观测」；`taskAgentRun` 却在缺席时
  从 opencode 驱动的实时捕获文件借来一个 no-op 句柄（`?? NOOP_HANDLE`），只为后面无条件地 `stop()` 与读 `stats().insertedPartIdsBySession`。
  这张去重表唯一的读者是 opencode 的会话捕获，它对「没给」与「给了空表」一视同仁（`alreadyInsertedPartIds?.get(...)`）。
- **intent `turnSession` 取 `services/sessionEventSink`**：intent 的轮次事件 sink 为了 `implements SystemAgentEventSinkV1` 与两个捕获状态联合类型
  经 `services/` 转手取 runtime-management 的会话事件合同；intent → runtime-management 不是目标 DAG 给的边，这个合同 intent 只能经 `services/`
  拿到。而 sink 写进去的形状早已由 intent 自己的持久化端口命名：轮次的捕获终态与未完成原因（`IntentTurnRecord.captureState` /
  `captureIncompleteReason`）、轮次事件记录（`IntentTurnEventRecord`，`kind: string`）。intent 的系统代理运行端口还反向取了 application 层的
  sink 类（`eventSink?: IntentTurnSessionEventSink`）。

第三条（runtime-management `agentMaterialEvidence` 取会话捕获 / 清扫上下文）要等会话捕获持久化端口的归属定下来、驱动一族归位，不在本 RFC。

## 2. 目标

- **G1 无实时捕获按缺席处理**：`taskAgentRun` 不再借 no-op 句柄——没有 `startLiveCapture` 时不起捕获、不 stop，后续会话捕获不带去重表
  （有句柄时照旧带上）。`services/runtime/index` 不再再导出 `NOOP_HANDLE`（opencode 自己 `pollMs === 0` 的关停路径照旧用它）。
- **G2 intent 自持轮次事件 sink 合同**：intent 的系统代理运行端口声明 `IntentTurnEventSink` 与它的三个形状（捕获终态、未完成原因、观测到的
  事件），全部由 intent 持久化端口里的记录类型派生；`IntentTurnSessionEventSink` 改为实现它，端口的 `eventSink` 改取这个接口。它与
  runtime-management 的 `SystemAgentEventSinkV1` 由用例编译期逐项锁成同一份合同。
- **G3 账本下降**：`R2` 3 → 1（task-execution、intent 各 1 条）；`R1` 不变；不新增目标 DAG 之外的边、跨 context 内部文件对、off-DAG offered
  文件对与 `module-layer-violations`；public surface 偏差不升。

## 3. 非目标

- runtime-management `agentMaterialEvidence` 取 `services/runtime/types` 的会话捕获 / 清扫上下文（余下 1 条 `R2`）：它们带 task-execution 的会话
  捕获持久化端口与日志器，要先把这个持久化端口的归属定下来（runtime-management 的捕获写到哪里由谁定义），随驱动一族归位。
- 驱动接口、执行上下文与驱动实现。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`taskAgentRun` 不再取 `services/runtime`、不再出现 `NOOP_HANDLE`；无实时捕获时不起、不停、不带去重表，有时照旧；intent 的
  application 层零取 `@/services/`，系统代理运行端口不再取 application 层的 sink 类。
- **AC-2**：架构计数按实测：`R2` 3 → 1（账本逐条相等），`R1` 不变；public surface 偏差不升；越界类计数不升。
- **AC-3**：受影响用例（实时捕获与会话捕获、intent 轮次会话与 turn engine、系统代理运行）全部通过；新增 RFC-464 用例。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **缺席就是缺席，不在 task-execution 另造 no-op 句柄**：把 no-op 句柄搬进 runtime-management 并经 public 导出，会给 public surface 添一个
   带函数成员的根（偏差 +1）；在 task-execution 里抄一份，则与 opencode 自己的关停句柄成了同一语义的两份实现。按合同注释「缺席即原意」直接
   处理可选能力最简单：两处 `stop()` 改为可选调用，去重表只在有句柄时带上——它唯一的读者对缺席与空表一视同仁，claude 的会话捕获不读它。
2. **intent 的 sink 合同由消费方声明、从自己的持久化形状派生**：intent 不取 runtime-management（目标 DAG），会话事件合同又不该为 intent 进
   shared；intent 写进去的形状本来就是它持久化端口里的记录，sink 合同从那里派生，单一事实源仍在 intent 内部。与 runtime-management 合同的
   一致性由 RFC-464 用例按函数类型逐项锁住（方法写法是双变的，单靠赋值检查锁不住参数收窄）。
