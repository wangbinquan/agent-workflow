# RFC-476 设计

**落在哪个 context、哪一层**：task-execution（删除实现与评审变更队列进 `infrastructure`，队列合同进 `application/ports`，参与方经
`public/participants` 交出，启动恢复经 `composition/bootRecovery.ts` 交给 bootstrap）；collaboration（评审作用域解析的适配器进 `infrastructure`）。
**承担的演进**：W9-D 的一步——两个 `services/` 文件退役，`R1` 少 4 条；collaboration 经 task-execution 的 public 合同进评审变更队列（目标 DAG 的
offered 方向），task-execution 不取 collaboration 的值。
**留下的债**：其余 30 条 `R1` 见 proposal §3；`deleteTask` 整份迁入、未按内容分层（RFC-294 C10，见 §7）。

## 1. task-execution：任务删除（`infrastructure/taskDelete.ts`）

- `services/taskDelete.ts` 整体迁入，`deleteTask` 与 `DeleteTaskResult` 的函数体、错误码与文案不变；文件头注释保留并补一行 RFC-476 来由。
- 对 task-execution 自己的符号改取定义处（不经自己的 public，也避免 public → infrastructure → public 的值环）：
  `createTaskDeletionQueries` ← `./taskDeletionQueries`；`createTaskDeletionParticipantInTx` ← `./taskDeletionParticipant`；
  `TaskDeletionEffects` ← `../application/ports/taskDeletionContentEffects`；`TaskExecutionPermits` ← `../application/ports/taskExecutionPermits`；
  `ActiveTaskExecutionParticipant` ← `../application/ports/taskExecutionRuntimeParticipants`；终态维护认领的 assert / transition ←
  `./terminalMaintenanceClaim`；终态维护 store 由 `new DrizzleTerminalMaintenancePersistence(db)` 直接构造（即 public
  `createTerminalMaintenanceStore` 的函数体）。
- 删除事务里 collaboration 的一半（冻结受众快照、删无 FK 的反馈行）改为注入：task-execution 新增自有端口
  `application/ports/taskDeletionCollaboration.ts`（`TaskDeletionCollaborationPort` 的 `members` / `deleteFeedback`，与按事务绑定的
  `TaskDeletionCollaborationInTx`），`deleteTask` 的选项多一格必填的 `collaboration`，`TaskRouteOperationsDependencies` 多一格必填的
  `taskDeletionCollaboration`；bootstrap（`daemonModules/taskExecution.ts`）把 collaboration public 的
  `createTaskDeletionCollaborationParticipantInTx` 交进来（结构上满足这个端口）。原 legacy 文件直接取 collaboration 的值；迁进 task-execution 后
  再这么取就是 DAG 外的值依赖（见 plan 集中验证）。
- 文件末尾对 `recoverInterruptedTaskDeletes` 的转出删除；`composition/bootRecovery.ts` 从 `../infrastructure/taskDeleteRecovery` 转出它，
  `bootstrap/daemonApplication.ts` 改从这里取。
- `infrastructure/taskRouteOperations.ts` 改取 `./taskDelete`。

## 2. 评审变更队列

### 2.1 task-execution 合同（`application/ports/taskReviewMutationQueue.ts`）

```ts
/** 在一个任务的评审变更临界区里执行的一段工作。 */
interface TaskReviewMutation<T> {
  run(): Promise<T>
}
/** 任务要等调用方刚发出的 lookup 解析后才知道的工作。 */
interface TaskReviewScopedMutation<T> extends TaskReviewMutation<T> {
  /** lookup 没找到任务：不进任何队列、直接收场（如以调用方的 not-found 拒绝）。 */
  missing(): Promise<T>
}
/** 评审写入与任务取消共用的每任务 FIFO。 */
interface TaskReviewMutationQueue {
  serialize<T>(taskId: string, mutation: TaskReviewMutation<T>): Promise<T>
  serializeAfterLookup<T>(
    lookup: Promise<string | null>,
    mutation: TaskReviewScopedMutation<T>,
  ): Promise<T>
}
```

### 2.2 task-execution 实现（`infrastructure/reviewMutationQueue.ts`）

- 原文件的队列部分整体迁入：两个进程内表（`taskTails`、`inflightScopeLookups`）、`reserveTaskReviewMutationSlot`、`withTaskReviewMutationLock`、
  `claimTaskQueueSlot`、`enterTaskQueue`、测试可见的 `__hasTaskReviewMutationQueueForTesting`，逐字不变。
- 原 `withReviewNodeMutationLock` 拆成两半：登记在途解析并在解析出任务后入队的一半留在这里，名为 `serializeAfterTaskLookup(lookup, mutation)`
  ——lookup 发出的同一刻同步登记 `tracked`，`lookup.then` 里任务为 `null` 时调 `mutation.missing()`，否则经 `enterTaskQueue` 以
  `mutation.run()` 入队（与原来的 `enter` 同一条路径：不再等其他在途解析）。
- 参与方 `taskReviewMutationQueue = Object.freeze({ serialize, serializeAfterLookup })`，分别落到 `withTaskReviewMutationLock` 与
  `serializeAfterTaskLookup`；`public/participants.ts` 只转出这个值（合同类型没有模块外消费方直接取，不上 public）。
- task-execution 的四个调用方（`infrastructure/sourceTerminationParticipant.ts`、`infrastructure/taskDriverLifecycle.ts`、
  `infrastructure/childTaskLifecycleParticipant.ts`、`composition/taskEngineApplication.ts`）改取 `./reviewMutationQueue`，调用逐字不变。

### 2.3 collaboration 适配器（`infrastructure/reviewMutationLock.ts`）

- 从 task-execution `public/participants` 取 `taskReviewMutationQueue`，交出与原来同名同形的两个函数：
  `withTaskReviewMutationLock(taskId, fn)` → `serialize(taskId, { run: fn })`；`withReviewNodeMutationLock(source, nodeRunId, fn)`：构造评审
  作用域解析器（同原来的 `'findTaskId' in source` 判断），`serializeAfterLookup(resolver.findTaskId(nodeRunId), { run: fn, missing })`，
  `missing` 同步抛 `NotFoundError('review-not-found', …)`（与原来在 `lookup.then` 里抛出同一个拒绝）。
- `infrastructure/review.ts`、`infrastructure/taskCollab.ts` 改取 `./reviewMutationLock`，调用逐字不变。

## 3. task-execution public 收口

迁入后逐个查 task-execution public 上只剩这份删除实现在取的符号：`createTaskDeletionQueries` / `TaskDeletionQueries`（`public/queries`）、
`createTaskDeletionParticipantInTx` / `TaskDeletionParticipant`、`createTerminalMaintenanceStore` / `TerminalMaintenanceStore`、
`assertTerminalMaintenanceClaimTx`、`transitionTerminalMaintenanceClaimTx`、`ActiveTaskExecutionParticipant`（`public/participants`）——模块外都已
无生产消费方，撤出（定义处不变），取它们的用例改取定义处；`rfc294-architecture-preflight` 钉住的偏差清单删去挂在这些根上的三条（偏差只降）。

## 4. 用例、账本与清单

- 改取新位置：删除一族（`rfc243-parent-child-lifecycle`、`rfc287-t13-deferred-prep`、`rfc311-branch-started-at-maintenance`、
  `rfc328-durable-ownership`、`rfc359-w7-terminal-maintenance-sync-cutover`、`rfc359-w8-t28-lost-update`、`rfc370-task-deletion-effects`；
  直接调 `deleteTask` 的用例交 collaboration 的事务内参与方，`helpers/eachProviderTaskExecution` 与 `rfc359-w7-task-route-conformance`、
  `rfc359-w8-task-route-capability-parity` 的路由依赖补 `taskDeletionCollaboration`），
  队列一族（`fusion-engine`、`lifecycle-repair-S1`、`review-cancel-concurrency`、`review-multidoc`、`rfc326-review-decision-transaction`、
  `rfc359-w11-cancel-parity`、`rfc359-w12-source-termination-atom`、`rfc359-w5hm-attach-review-lock-parity` 取 task-execution 的队列；
  `review-decision-full-asserts` 对模块命名空间的 `spyOn` 改指 collaboration 适配器的 `withReviewNodeMutationLock`），收回符号的用例
  （`rfc395-a7-horizontal-participants`、`rfc395-a7-horizontal-queries`、`rfc395-q3-cost-retention`）改取定义处。
- 源码锁：`rfc359-t7c-task-delete-recovery` 的「services/taskDelete 只再导出」改锁 bootstrap 从 `composition/bootRecovery` 取
  `recoverInterruptedTaskDeletes`、`composition/bootRecovery` 转出恢复实现、删除实现取 `./taskDeleteRecovery` 而不自己定义它。
- 账本：`architecture/commons-debt.json` 删 4 条 `R1`、基线 34 → 30；`rfc359-w5-unattended-void-promise` 的路径计数改为 task-execution 的队列
  文件；架构报告 owner 表删两个条目；`guard-manifest` 行数随登记守卫刷新；`architecture/counts.json` 把本 RFC 触及的两项减速带收紧到实测
  （§7 C13）；注释里的旧路径改指新位置。
- 新增 `tests/rfc476-task-delete-and-review-queue-owners.test.ts`：两个文件不在、零 import / 路径字面量 / Markdown 链接（各带负对照）；`R1`
  里没有它们（带负对照）；队列不取 collaboration、collaboration 只经 task-execution public 进队列（带负对照）、删除实现不取自己的 public、
  也不取 collaboration（协作一半取 task-execution 自有端口，bootstrap 注入 collaboration 的实现，带负对照）；
  参与方的导出（只交值、冻结、两个方法）；收回的符号不在 public 上；bootstrap 取启动恢复的位置；队列行为——同一任务串行、不同任务并行、
  同步取号、已发出的作用域解析排在之后的 task 键入口前面、解析不到任务走 `missing` 不入队、失败不毒化后来者。

## 5. 失败模式

- 漏改某个消费方或漏接注入 → tsc 报错（`collaboration` / `taskDeletionCollaboration` 都是必填）；路径字面量与 Markdown 链接由 RFC-476 用例锁。
- task-execution 取 collaboration 的值 → `context-value-sccs` / `context-value-pairs-off-dag` 闸门报出（初版即如此，见 plan 集中验证）。
- `serializeAfterTaskLookup` 改成先等其他在途解析、或登记晚于发出 → 评审与取消的排队次序走样，`review-cancel-concurrency`、
  `rfc359-w11-cancel-parity` 与 RFC-476 的排序用例报出。
- task-execution 内部取自己的 public 造成值环 → `backend-value-scc` 闸门报出。

## 6. 测试策略

既有删除、评审并发、取消一致性、源终止与 P0 用例照常覆盖行为；新增 RFC-476 用例锁结构与队列行为。集中验证按 RFC-475 的做法：导出仓库里
全量 SQLite、PostgreSQL lane、P0 变异 lane、四个包、计数复核与同一时刻的对照。

## 7. 收口前对账 RFC-294 C10～C13

RFC-294 plan §0 第 6 条要求在制 RFC 收口前按 proposal §6 的约束对账；C10～C13 自 2026-11-09 起生效，晚于本 RFC 的设计与实施，
RFC-294 plan §4.7 写明本 RFC「按原方式收口」。逐条如下：

- **C10 用例入口归 application**：`deleteTask` 是 `tasks:delete` 的用例入口，本 RFC 把它整份迁进 `infrastructure/taskDelete.ts`、没有按
  内容分层，正是 C10 此后不再允许的「原样停放」；按 plan §4.7 的收口方式不在本 RFC 拆分。拆成 application 用例（前置门与事务编排）与
  infrastructure 端口实现（查询、清理、恢复）随 task-execution 存量按 proposal D14 归位。队列与 collaboration 适配器是进程内协调机制，
  不是用例入口。
- **C11 public 不新增内部构件**：public 新增的只有 `taskReviewMutationQueue`——两个方法的闭合接口参与方，不是 SQL 片段 / 条件构造器、
  行形状的通用查询工厂或状态写原子；`public/operations.ts` 未动；同时撤出九个符号（§3）。队列的两张进程内表随文件原样迁入、没有 setter；
  架构报告的模块级可变状态清单（`ambientWiring`）前后都是 79 条、逐条相同。
- **C12 锁的覆盖范围如实**：本 RFC 的结构锁各自的覆盖范围写在 plan 的集中验证里。
- **C13 减速带随收口收紧**：本 RFC 触及的两项减速带收紧到实测值——`legacy-horizontal-files` 381 → 173、`legacy-service-implementations`
  213 → 54（`architecture/counts.json`，reason 含 `max=<N>`）；其余计数实测不变，不在本 RFC 收紧。
