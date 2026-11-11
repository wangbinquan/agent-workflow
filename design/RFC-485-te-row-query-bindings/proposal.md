# RFC-485 collaboration 与 memory 取 task-execution 的三个行形状查询工厂改经装配期注入（RFC-294 S9 第四步）

- **状态**：In Progress（2026-11-11）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 design §7，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、
  只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 2 项（类型污染清单里「收裸 db 句柄的查询
  工厂」），task-execution ↔ collaboration 这一对的第四步；memory 是这三个工厂在模块外的另一个使用方，一并处理。
- **前序**：[RFC-482](../RFC-482-te-participant-bindings-small-families/proposal.md)（Done，`42b52316d`）把五个工厂改经 RFC-400 的装配期
  绑定；本 RFC 用同一机制处理余下的三个。**后续**：RFC-483（SQL 片段）不变。

## 1. 背景

1. **三个收持久化句柄的 public 工厂**：task-execution 的 `public/queries` 交出 `createNodeRunQueries`、`createTaskGateQueries`、
   `createNodeOutputQueries`，签名里带 `PersistenceDb`（`PUBLIC_SURFACE_DEBT` 的 3 条）。模块外的使用（HEAD `067169518`，语法树普查）：
   89 个调用点、62 个函数、26 个文件——collaboration 24 个文件，memory 2 个文件。collaboration 有 16 个函数（33 处）手里已有 RFC-400 / RFC-482
   的绑定，其余 46 个函数（含 memory 的 5 个）没有。
2. **交出的接口比用到的宽**：`NodeRunQueries` 16 个方法里，模块外只用 12 个（collaboration 11 个、memory 2 个，其中一个两边都用）；
   `NodeOutputQueries` 5 个方法里模块外用 4 个；`TaskGateQueries` 4 个方法都被 collaboration 用到。
3. **memory 只在根 db 上读**：memory 的蒸馏工作存储与注入读存储用 `listHistoryFields`、`latestHistoryPerNode`、`listActiveContents`、
   `listFields`，句柄都是装配时给的根 db；bootstrap 已用同样方式把 collaboration 的 `clarifyAnswers` 查询建好交给 memory。

## 2. 目标

- **G1 collaboration 改经绑定**：`TaskExecutionParticipantBindings` 增加这三个工厂引用（类型取 task-execution 交出的闭合读取接口），bootstrap
  从 task-execution 的 composition 取来；collaboration 的调用点改用绑定，手里没有绑定的函数沿调用链接上。调用点照旧传原来的句柄——
  事务里的仍是事务（`PersistenceTx` 即 `PersistenceDb`，只能交工厂）。
- **G2 memory 改经装配输入**：memory 的装配输入增加 task-execution 的两个只读端口，bootstrap 用根 db 建好交入（与 `clarifyAnswers` 同一条路）；
  memory 的两个存储改收端口。
- **G3 只交出用到的读取**：task-execution 在 `application/ports` 声明闭合接口 `TaskNodeRunReads`（模块外用到的 12 个方法）与
  `TaskNodeOutputReads`（4 个），`NodeRunQueries` / `NodeOutputQueries` extends 它们；从 `public/types` 交出两个闭合接口与 `TaskGateQueries`。
  `public/queries` 撤出三个工厂与只经它们可达的全量接口名。
- **G4 锁与账本**：新增 RFC-485 用例；`PUBLIC_SURFACE_DEBT` 销 3 条，减速带收紧到实测。

## 3. 非目标

- SQL 片段（RFC-483）；其他 context 对的类型污染；查询的 SQL、语义与事务边界；行形状类型本身（`NodeRunFactSnapshot` 等仍由
  task-execution 交出）。
- 不做评审 / 提问用例的整体归位（RFC-294 review §9 待用户决定）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 的 public 不再导出这三个工厂；collaboration 与 memory 的生产文件不再从 task-execution 取它们；collaboration 经绑定、
  memory 经装配输入取得读取能力。
- **AC-2**：`TaskNodeRunReads`、`TaskNodeOutputReads` 是只有方法签名的闭合接口，从 `public/types` 交出；task-execution 的未消费 public 符号
  仍为 0。
- **AC-3**：`public-surface-deviations` 68 → 65（这一对 22 → 19）并收紧到实测；跨 context 内部文件对与越 DAG 的 offered 文件对不变。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
