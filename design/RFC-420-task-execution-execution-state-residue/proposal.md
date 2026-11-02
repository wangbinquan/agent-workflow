# RFC-420 task-execution 执行状态绑定里的残余逻辑迁出 composition（RFC-294 S6）

- **状态**：Done（2026-11-01 落档并实施；exact SHA `d9a5aefaa` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-419](../RFC-419-task-execution-host-launch-recovery-infrastructure/proposal.md)；对应 RFC-416 proposal §7 第 4 项。
- **落位**：
  - task-execution `application/`：闭包端口读、上一次 fan-out 尝试的消费记录、fan-out agent 与源端口种类解析、子调用的继承面；
  - `engine/`：wrapper body 的进入、调用行 iso 的重建；
  - `domain/`：协作者投影；
  - `composition/`：只剩构造与注入。

## 1. 背景

RFC-416 的盘点（§7 第 4 项）列出了执行状态绑定里残留的逻辑。它们写在 composition 的端口绑定里，直接读 `TaskMechanicsState`：

- **`composition/wrapperMechanics.ts`**
  - `readPort`（约 30 行）：按读者的 frame 加载环境链，判定源节点在该作用域是否可见。不可见抛 `closure-binding-unresolved`，可见则在解析出的
    frame 读端口行。
  - `priorFanoutConsumed`（约 18 行）：在一次快照读里，取同一轮中上一次顶层 fan-out 尝试的消费记录，并编码。
  - `resolveFanoutAgent`（约 6 行）：按 fan-out 规范键（RFC-223）解析 agent；name-only 节点返回 missing。
  - `scopeDriver.drive`（约 40 行），依次执行：
    1. 按场景句柄构造 wrapper body 的仓库挂载与容器根：loop 保留外层的挂载路径与只读，git 用 iso 的挂载、非只读；
    2. 建 scope 日志；
    3. 补完被中断的合回（RFC-370）；
    4. 驱动 body scope。
- **`composition/agentNodeExecution.ts`** 的 `sourcePortKindOf`（约 18 行）：生产端口的声明种类。
- **`composition/childCallNodeExecution.ts`**
  - `delegatedCallActor` 与无 owner 兼容 actor（约 30 行）：NULL owner 投影为无权限的兼容 actor，否则经 identity-access 的委托授权取 actor。
  - `buildChildRuntime`（约 8 行）：子任务继承的运行时。
  - `restoreIso`（约 20 行）：从持久化列重建调用行的 iso，顺序沿用续跑惯例——scope、每个任务仓库的 HEAD、恢复键、restore。
- **`composition/taskEngineApplication.ts`** 的协作者投影（约 7 行）：去掉 owner 与空 userId，再去重。

RFC-416 当时写的前提是「先把 `TaskMechanicsState` 收为端口」。本 RFC 不把整个状态类型做成端口，按两种情形处理：

- 一般情形：每块逻辑只取它读到的几个字段（窄入参）。
- 唯一要在 body 状态上递归的是 wrapper body 的进入：engine 以泛型 `S` 接收 composition 组装的状态，不认识它的类型。

## 2. 目标

- **G1 wrapper 数据读与 agent 解析迁入 application**：
  - `readPortInScope`、`priorFanoutConsumedJson` 进入 `application/nodeInputs.ts`；
  - `resolveFanoutAgent`、`sourcePortKindOf` 进入 `application/fanoutAgentResolution.ts`。

  wrapper 绑定与 agent 绑定共用一份 agent 解析入参。

- **G2 wrapper body 的进入迁入 engine**：`engine/wrapper/wrapperBodyScope.ts`（`wrapperBodyMounts`、`createWrapperScopeDriver`）。
- **G3 子调用**：
  - 继承面迁入 `application/childCallInheritance.ts`（`delegatedCallActor`、`buildChildRuntime`）；
  - iso 重建迁入 `engine/kernel/mergeRecovery.ts` 的 `restoreNodeIso`，复用同文件的 `scopeBaseHeads`。
- **G4 协作者投影迁入 domain**：`domain/taskCollaborators.ts`。
- **G5 清理**：删除零引用的 `NodeMechanicsResult`；`TaskScopeArgs` 改为 `DagScopeArgs` 的别名（两者同形）。
- **G6 纯结构**：以下全部不变——
  - 错误文本与 frame 解析；
  - 快照读的选择条件；
  - agent 解析的结果映射；
  - 挂载规则，合回与驱动的先后；
  - 委托授权的入参与 NULL owner 投影；
  - 子运行时的字段；
  - iso 重建的调用顺序；
  - 协作者投影规则。

## 3. 非目标

- 本地 agent 调用适配器与本地 run family（RFC-416 §7 第 2 项，需先补 runtime-management 的 public 合同）。
- composition 其余的小块与收口锁（第 5 项的其余部分）。
- `TaskMechanicsState` 本身的形状（字段增删），以及各端口接口的形状。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：
  - 各块主体位于新 owner，composition 不再含它们（结构锁锁定，含负例）；
  - 新文件遵守层规则：application / engine / domain 不 import composition、infrastructure 与 `@/services`。
- **AC-2 行为不变**：以下既有用例与 P0 变异 lane 全部通过，断言意图不变——
  - wrapper：loop / git / fan-out、闭包读、续跑合回；
  - 调用节点：委托 actor、子运行时、续跑；
  - 任务启动：协作者。
- **AC-3 守卫**：读源码的锁随 owner 改指，各锁判据不变。涉及：
  - RFC-285 B3、RFC-284 T20、RFC-305、RFC-347（`.forCall(` 的唯一调用点）；
  - RFC-271、RFC-193，RFC-345 的 catalog session 读取计数；
  - RFC-404 / RFC-407 结构锁的符号 owner；
  - `executionMechanismSources` 语料。

  新结构锁带负例。

- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **不把 `TaskMechanicsState` 整体收为端口**，改用窄入参加泛型 `S`。整体收为端口会把装配类型带进 application / engine；窄入参与既有的
   `pickInheritableRunConfig(state.opts)` 一致。
2. **`delegatedCallActor` 进 application，而非 identity-access**：NULL owner 的兼容投影是调用节点的 D6/Q5 决定，属于 task-execution；identity-access
   只提供委托授权工厂（public participant）。RFC-347 账本里 `.forCall(` 的唯一调用点改指新文件。
3. **`restoreNodeIso` 放在 `engine/kernel/mergeRecovery.ts`**：
   - 它与续跑合回共用 `scopeBaseHeads` 和 restore 惯例，经 `IsolationMechanicsPorts`；绑定改为 `restoreNodeIso(createIsolationMechanicsPorts(state), input)`。
   - 调用顺序与原写法相同（scope、HEAD、恢复键、restore）；submodule 拓扑仍由隔离端口的 restore 转换。
4. **两个绑定共用一份 agent 解析入参**（`agentResolutionResources(state)`，在 `agentNodeExecution.ts`）：wrapper 绑定不再自己读 catalog session，
   RFC-345 锁里的字面读取因此由 4 处变为 3 处。
5. **保留 `sourcePortKindOf`、`delegatedCallActor`、`buildChildRuntime` 的名字**：多处锁与注释按名字引用它们。
