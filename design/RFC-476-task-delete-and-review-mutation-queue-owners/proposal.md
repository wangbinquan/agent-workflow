# RFC-476 任务删除与评审变更队列归 task-execution（RFC-294 W9-D 第二十三步）

- **状态**：Done（2026-11-09，落地 `9184e1e5a`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（2026-11-09
  再次下达）：本会话调研、设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本
  会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 业务实现按 owner 归位、越界边收口）
- **前序**：RFC-222 / RFC-305（终态任务硬删除）；RFC-359 T7c / W7（删除认领与崩溃恢复的中立实现、终态维护认领）；RFC-076 / RFC-359（评审写入与
  任务取消共用的每任务 FIFO 临界区，「先发出者先入队」）；[RFC-475](../RFC-475-commit-push-owner-split/proposal.md)（public 合同用闭合接口、
  失去模块外消费方的 public 符号当场收回）。
- **落位**：`services/taskDelete.ts` 迁为 task-execution `infrastructure/taskDelete.ts`，`recoverInterruptedTaskDeletes` 经 task-execution
  `composition/bootRecovery.ts` 交给 bootstrap；`services/reviewMutationCoordinator.ts` 的队列迁为 task-execution `infrastructure/reviewMutationQueue.ts`，
  collaboration 经 task-execution `public/participants` 的闭合接口参与方 `taskReviewMutationQueue` 进同一个队列，评审作用域解析（node run → task）
  与找不到时的错误留在 collaboration 的 `infrastructure/reviewMutationLock.ts`。两个 `services/` 文件删除。

## 1. 背景

`R1`（非模块文件取模块内部）余 34 条，其中 4 条出在两个 `services/` 文件上：

1. **`services/taskDelete.ts`**（316 行，2 条：取 task-execution `infrastructure/taskDeleteRecovery` 的类型与值）。`tasks:delete` 的硬删除
   实现——前置门（非终态 / 在跑 / fusion 内部任务各 409）、终态维护认领、事务内重验与删行、事务后的磁盘清理与 tasks-list 广播——全部是
   task-execution 的事；它只被 task-execution 的 `infrastructure/taskRouteOperations.ts` 与 bootstrap 用（后者只取它转出的
   `recoverInterruptedTaskDeletes`）。账本的退役条件写的就是「legacy 任务删除服务并入 task-execution」。
2. **`services/reviewMutationCoordinator.ts`**（125 行，2 条：取 collaboration 的评审作用域解析端口类型与数据库实现）。评审写入会改兄弟
   评审行、任务取消要封住所有未决评审，两者共用这份进程内每任务 FIFO：collaboration 的评审与协作者写入、task-execution 的取消、驱动接管、
   源终止与引擎装配都进同一个队列。它一半是「按任务串行化写入」的机制（键是任务），一半是 collaboration 的评审作用域解析（评审 node run
   属于哪个任务、找不到时 404）。目标 DAG 上 collaboration → task-execution 是 offered 边，task-execution → collaboration 只有
   required-implementation（task-execution 实现 collaboration 声明的端口，没有值依赖）。

## 2. 目标

- **G1 任务删除归 task-execution**：文件迁为 `infrastructure/taskDelete.ts`（函数体不变），对 task-execution 自己的东西改取定义处而不经自己
  的 public；删除事务里 collaboration 的一半改经 task-execution 自有端口 `TaskDeletionCollaborationPort` 注入（bootstrap 交 collaboration 的
  实现）；`recoverInterruptedTaskDeletes` 由 `composition/bootRecovery.ts` 转出给 bootstrap（bootstrap 本就从这里取启动恢复）。
- **G2 评审变更队列归 task-execution**：队列（每任务 FIFO、在途作用域解析登记、同步取号）迁为 `infrastructure/reviewMutationQueue.ts`，排队
  规则逐字不变；task-execution 的四个调用方直接取它。`public/participants` 交出闭合接口参与方 `taskReviewMutationQueue`
  （`serialize(taskId, mutation)` 与 `serializeAfterLookup(lookup, mutation)`，工作单元是带方法的对象——public surface 偏差规则把函数类型参数记为开放类型），合同
  类型在 `application/ports/taskReviewMutationQueue.ts`。collaboration 新增 `infrastructure/reviewMutationLock.ts`：同名同形的
  `withTaskReviewMutationLock` 与 `withReviewNodeMutationLock`（作用域解析器与 `review-not-found` 留在这里），`review.ts` / `taskCollab.ts` 只改
  import。
- **G3 public 收口**：按 RFC-294 design §3.3（没有生产 consumer 的 symbol 不公开），task-execution public 上只剩这份删除实现在取的符号当场
  收回（以计数复核为准），用例改取定义处。
- **G4 账本**：`R1` 34 → 30（按实测销账）；`services/` 55 → 53，`legacy-horizontal-files` 与 `legacy-service-implementations` 各 −2，两项
  减速带收口时收紧到实测（RFC-294 C13，design §7）；public surface 偏差与未被消费的 public 符号不升，上下文值环与 off-DAG 值对保持 0。

## 3. 非目标

- 其余 `R1`：`services/task.ts`（9）、`services/systemAgentRun.ts`（5）、运行时驱动一族与 `services/runtimeSmoke.ts`（13）、
  `services/nodeRollback.ts`（3，collaboration 的评审与反问直接调它，需要 collaboration 自有的回滚端口，另行处理）。
- 队列的形态：仍是进程内每任务 FIFO（不改为数据库锁或跨进程协调），排队规则逐字不变。
- 行为：删除的前置门、错误码与文案、事务边界、清理与广播、恢复路径逐字不变；评审与取消的排队次序、`review-not-found` 不变。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/taskDelete.ts`、`services/reviewMutationCoordinator.ts` 不在、零引用（import、路径字面量、Markdown 链接）；`R1` 里没有它们的边。
- **AC-2**：行为不变——删除的 409 门、事务与清理、恢复由既有删除用例覆盖；评审 / 取消的同任务排队与「先发出者先入队」由既有评审并发、
  取消一致性与源终止用例覆盖。
- **AC-3**：架构计数按实测（`R1` 34 → 30），账本逐条相等；public surface 偏差、未被消费的 public 符号与越界类计数不升；触及的两项减速带
  收紧到实测值。
- **AC-4**：受影响用例与新增 RFC-476 用例全部通过；四个包的用例都跑。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **两个文件放一个 RFC**：都退役进 task-execution，集中验证共用一轮。
2. **队列归 task-execution，作用域解析留在 collaboration**：队列按任务串行化写入，键与取消都是 task-execution 的；DAG 上只有
   collaboration → task-execution 的 offered 边。初版把整份文件放进 collaboration、task-execution 经 collaboration public 取值，计数复核报出
   上下文值环与 off-DAG 值对（见 plan 集中验证），改为现在的方向。
3. **public 合同用闭合接口**：`serialize` / `serializeAfterLookup` 收带方法的工作单元对象，不收回调函数；task-execution 内部与 collaboration 的
   适配器仍用函数形状，调用方只改 import。只交出参与方的值，合同类型不上 public（没有消费方直接取它们）。
4. **失去模块外消费方的 task-execution public 符号当场收回**（RFC-475 同例），不留零消费者的公共符号。
5. **删除的协作一半用 consumer 自有端口注入**：不在 task-execution 里取 collaboration 的值或类型（RFC-294 design §3.3：required SPI 由 consumer
   拥有），collaboration 现有的事务内参与方结构上满足它，由 bootstrap 接线；`deleteTask` 与路由依赖上的这一格都是必填（不给默认值）。
6. **按 RFC-294 plan §4.7 的原方式收口**（2026-11-09 总纲第二次校正）：`deleteTask` 整份迁入 infrastructure、不在本 RFC 按内容分层（C10 此后
   不再允许，本 RFC 设计与实施在其生效之前）；收口前按 C10～C13 逐条对账（design §7），C13 的两项减速带在本 RFC 收紧。
