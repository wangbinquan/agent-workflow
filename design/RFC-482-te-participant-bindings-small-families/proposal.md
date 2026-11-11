# RFC-482 collaboration 取 task-execution 的事务参与者与三个小查询改经装配期绑定（RFC-294 S9 第三步）

- **状态**：Done（2026-11-11，落地 `42b52316d`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §7，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、
  只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 2 项（类型污染清单里「收裸 db 句柄的查询
  工厂」与「tx-bound participant 的构造方式由后继 design 给出」），task-execution ↔ collaboration 这一对。RFC-481 落档时把 collaboration 取的
  9 个工厂与参与者记为 RFC-482；本 RFC 普查调用点（design §1）后按机制再拆：
  - **RFC-482（本 RFC）**：三个事务参与者（`createHumanGatePersistenceParticipantInTx`、`createConsumedInputsParticipantInTx`、
    `reselectRunInTx`）、clarify 指令持久化（`createTaskClarifyDirectivePersistence`）、任务主题查询（`createTaskSubjectQueries`）与 run
    selection 读取（`createRunSelectionReader`），6 条类型污染；
  - **下一步**（编号落档时分配）：`createNodeRunQueries`、`createTaskGateQueries`、`createNodeOutputQueries` 三个行形状查询工厂，3 条——
    collaboration 24 个文件、84 个调用点，所在的 57 个函数里 47 个手里没有绑定，另有 memory 2 个文件的 5 个调用点；
  - **RFC-483**：collaboration 拼进自己查询的三个 SQL 片段（8 条），不变。
- **前序**：[RFC-481](../RFC-481-te-owned-human-gate-ports/proposal.md)（Done，`fdc78adf8`，Done 文档 `68086c6cd`）。

## 1. 背景

1. **六个收持久化句柄的 public 符号**：task-execution 的 `public/participants` 与 `public/queries` 交出 6 个签名里带 `PersistenceDb` /
   `PersistenceTx` 的工厂与操作，模块外只有 collaboration 在用（10 个文件、30 个调用点）。RFC-400 已给出这一类的先例：task-execution 的 public
   只交出参与者接口，工厂引用由 bootstrap 作为装配输入交给 collaboration（collaboration 在消费侧声明的 `TaskExecutionParticipantBindings`）。
2. **一个空操作**：`reselectRunInTx` 是 RFC-395 II-a「端口先行」时留下的占位——不读不写、返回空数组；collaboration 的评审决定里两处调用
   不产生任何效果。
3. **绕一圈的读取**：clarify 指令（节点的「继续 / 停止反问」）存储归 task-execution（RFC-395 A7）。task-execution 的引擎派发时读它，却经
   `CollaborationRuntimeMechanics.getNodeClarifyDirective` 问 collaboration，collaboration 再用 task-execution 的持久化工厂读回 task-execution 的
   表；collaboration 的 `infrastructure/taskClarifyDirective.ts` 只是这层转发（RFC-349 SQLite 兼容适配器的遗留）。

## 2. 目标

- **G1 五个工厂改经装配期绑定**：`TaskExecutionParticipantBindings` 增加这五个工厂引用，bootstrap 从 task-execution 的 composition 取来交给
  collaboration；collaboration 的调用点改用绑定，手里没有绑定的函数沿调用链接上（design §2）。task-execution 的 public 撤出这五个工厂，只交出
  它们的接口类型；run selection 的读取收成 collaboration 用到的三个方法的闭合接口。
- **G2 删除空操作**：`reselectRunInTx` 删除，评审决定里的两处调用去掉。
- **G3 引擎直接读自己的表**：task-execution 的持久化包增加 clarify 指令读取，引擎端口改接它；`CollaborationRuntimeMechanics` 去掉
  `getNodeClarifyDirective`；collaboration 的 `taskClarifyDirective.ts` 删除，其余调用方改用绑定。
- **G4 锁与账本**：新增 RFC-482 用例；`PUBLIC_SURFACE_DEBT` 销 6 条，减速带收紧到实测。

## 3. 非目标

- 三个行形状查询工厂与 memory 的使用（下一步）；SQL 片段（RFC-483）；其他 context 对的类型污染（S9 后续）。
- 不改参与者、查询与持久化的语义、SQL 和事务边界：collaboration 在事务里调用的，仍拿同一个事务句柄构造。
- 不做评审 / 提问用例的整体归位（RFC-294 review §9 待用户决定）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 的 public 不再导出这六个符号；collaboration 的生产文件改经绑定取这五个工厂，不再从 task-execution 取它们。
- **AC-2**：`reselectRunInTx` 不在；`CollaborationRuntimeMechanics` 没有 `getNodeClarifyDirective`，task-execution 引擎的 clarify 指令读取不经
  collaboration；collaboration 的 `taskClarifyDirective.ts` 不在。
- **AC-3**：`public-surface-deviations` 74 → 68（这一对 28 → 22）并收紧到实测；两个模块的未消费 public 符号仍为 0；跨 context 内部文件对与
  越 DAG 的 offered 文件对不变。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
