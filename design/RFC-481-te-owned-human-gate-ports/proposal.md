# RFC-481 task-execution 自有人工门端口：反向越 DAG 类型边清零与开放类型收口（RFC-294 S9 第二步）

- **状态**：In Progress（2026-11-10）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、
  只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9（public 合同收敛），task-execution ↔
  collaboration 这一对。RFC-480 做了未消费符号清零与 task-execution `public/operations` 退役；这一对余下的三项按依赖与风险再拆三步：
  - **RFC-481（本 RFC）**：第 5 项在这一对上的全部（task-execution → collaboration 的 8 条越 DAG 类型边），以及第 2 项里不牵动查询路径的
    三条类型污染（两个开放函数类型、collaboration 自己的一条持久化句柄）。
  - **RFC-482**：第 2 项里 collaboration 取 task-execution 的行形状查询工厂与事务参与者（9 条类型污染；collaboration 二十多个文件，仅
    `createNodeRunQueries` 与 `createTaskGateQueries` 就有 76 个调用点），改经 RFC-400 的装配期绑定，并把读路径按业务目的收窄。
  - **RFC-483**：第 4 项，collaboration 拼进自己查询的三个 task-execution SQL 片段（8 条类型污染）。它们服务的待评审 / 待澄清计数由
    RFC-359 AC-11 压成单条语句，往返数由 `rfc359-w57-clarify-badge-round-trip-budget` 双引擎钉住；换成业务查询不能退回多次往返，需要
    单独设计。
- **前序**：[RFC-480](../RFC-480-te-collaboration-public-unconsumed-sweep/proposal.md)（Done，`bb7da0e8d` + `489526d4a`）。

## 1. 背景

1. **task-execution 反向依赖 collaboration 的类型**：RFC-294 design §3.1 的目标 DAG 里 collaboration 依赖 task-execution，task-execution
   需要人工门能力时只依赖**自己定义**的 required 端口、由 collaboration 实现，task-execution 不 import collaboration。现状有 8 个
   task-execution 文件经 collaboration 的 public 取 4 个类型（全是 type-only），在 `off-dag-offered-file-context-pairs`（55）与
   `OFF_DAG_OFFERED_EDGE_DEBT` 里逐条登记：
   - `PreparedHumanGateRef`（collaboration domain）：task-execution 的停车用例与人工门生命周期端口拿它当入参；
   - `CollaborationRuntimeMechanics`（collaboration application/ports）：DAG 节点运行中 task-execution 调的评审派发、反问、借用等九个
     能力；
   - `TaskDagCollaborationOperations`（collaboration application/ports）：调度器读的待澄清证据、延后问题补发；
   - `CollaborationCommandContext`：task-execution 路由依赖里的一个字段，task-execution 自己不用，只是替 bootstrap 转手。
     前三个本来就是「task-execution 要求、collaboration 实现」的端口，只是声明放反了一边。
2. **两个开放函数类型**：task-execution `public/queries` 的 `loadFrameChain(read, frame)` 与 `resolveSourceFrame({…, containerRowById})`
   以函数类型收回调（collaboration 的评审取上游帧时用），类型污染检测报 `unsafe/open type FunctionType`。
3. **collaboration 自己的一条**：`createTaskDeletionCollaborationParticipantInTx(tx: PersistenceTx)` 从 collaboration `public/participants`
   交给 bootstrap；bootstrap 本可以取 composition，public 签名里不该出现持久化句柄。

## 2. 目标

- **G1 反向越 DAG 类型边清零**：`PreparedHumanGateRef`、`CollaborationRuntimeMechanics`（连同它的输入输出类型）、
  `TaskDagCollaborationOperations`（连同 `TaskDagOpenClarifyEvidence`）改由 task-execution 声明，从 task-execution 的 public 交出；
  collaboration 改取 task-execution 的定义并照旧实现。task-execution 路由依赖删去 `collaboration` 字段，bootstrap 直接持有它造的协作
  上下文。task-execution 的任何文件不再取 collaboration 的 public；唯一留下的 task-execution → collaboration 边是
  `application/adapters/collaboration-adapter.ts` 实现 collaboration 自有 required 端口的 type import（required-SPI 车道，design §3.1
  的虚线，本来就不在越 DAG 清单里）。
- **G2 开放类型收口**：两个帧函数的回调参数改为带方法签名的闭合接口。
- **G3 collaboration 那一条**：删除参与者工厂由 collaboration 的 `composition.ts` 交给 bootstrap，撤出 public。
- **G4 锁与账本**：新增 RFC-481 用例；`OFF_DAG_OFFERED_EDGE_DEBT` 销 8 条、`PUBLIC_SURFACE_DEBT` 销 3 条，减速带收紧到实测。

## 3. 非目标

- RFC-482、RFC-483 的范围（见上）；其他 context 对的类型污染与越 DAG 边（S9 后续）。
- 不改端口的成员与语义，不改名（名字描述的是 task-execution 要求的协作能力，归属换边不改合同）。
- 不改任何行为。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 的生产文件不取 collaboration 的 public（值与类型），指向 collaboration 的只剩 required-SPI 车道那一条；`off-dag-offered-file-context-pairs` 里 task-execution →
  collaboration 为 0，`OFF_DAG_OFFERED_EDGE_DEBT` 相应 8 条销账。
- **AC-2**：三个端口类型声明在 task-execution，collaboration 的实现取 task-execution 的 public；collaboration 的 public 不再交出它们。
- **AC-3**：`loadFrameChain`、`resolveSourceFrame` 与 collaboration 的删除参与者工厂不在类型污染清单里；`public-surface-deviations`
  与 `off-dag-offered-file-context-pairs` 收紧到实测；两个模块的未消费 public 符号仍为 0。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
