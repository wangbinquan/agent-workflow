# RFC-559 技术设计

落在 task-execution 与 collaboration（consumer 自有端口）两个 bounded context，memory 只撤出失去消费方的 public 符号；bootstrap 不改代码。另改两份
精确清单、`architecture/counts.json` 与新增一个 RFC-559 用例。数字取 HEAD `aee8de63c`。不改行为。

## 1. 改动

| 位置                                                                                                                                                                                          | 做法                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-execution `application/ports/taskMemoryInjection.ts`（新）                                                                                                                               | `TaskMemoryInjectionBudget`（五档字符预算）与 `TaskMemoryInjectionPort`（`injectForRun`、`loadFirstAttemptSnapshot`，入参与返回同 memory 的注入查询，类型只取 shared） |
| task-execution `application/ports/taskMemoryDistill.ts`（新）                                                                                                                                 | `TaskMemoryDistillPort`：`enqueue({ sourceKind: 'agent-run', sourceEventId, taskId, nodeId })`                                                                         |
| task-execution `application/ports/taskAgentRun.ts`、`composition/taskEngineRuntimeOptions.ts`、`infrastructure/taskExecutionRuntimeParticipants.ts`、`composition/agentRunDistillObserver.ts` | 改用上面两个端口                                                                                                                                                       |
| collaboration `application/ports/taskFeedbackMemoryDistill.ts`（新）                                                                                                                          | `CollaborationMemoryDistillPort`：`enqueue({ sourceKind: 'feedback', sourceEventId, taskId })`，返回 `{ jobId } \| null`                                               |
| collaboration 五个文件                                                                                                                                                                        | 改用它                                                                                                                                                                 |
| memory 的 public                                                                                                                                                                              | 撤出失去最后一个外部消费方的符号（以架构报告为准），memory 内部与用例改从定义处取                                                                                      |

bootstrap 交的仍是 memory 的 `memoryInjectionQueries` 与 `memoryOperations.distillCommands`：入参更宽、返回更具体，结构上满足三个端口。

## 2. 门与用例

- 精确清单：`rfc376-structural-guards` 的 `off-dag-offered-file-context-pairs` 与 `rfc294-review-offered-edge-dag` 的 `OFF_DAG_OFFERED_EDGE_DEBT` 删去 9 条；
  `counts.json` 44 → 35。
- 新增 `tests/rfc559-memory-consumer-owned-ports-boundary.test.ts`，登记 guard-manifest：① task-execution 与 collaboration 的全部源码不取 memory（带负对照）；
  ② 三个端口在各自的 `application/ports`，只取 shared；③ 编译期断言：memory 的注入查询与蒸馏命令可以赋给这三个端口。

## 3. 失败模式

- **memory 的注入查询或蒸馏命令改了签名**：bootstrap 交接处与新用例的编译期断言都会报类型错误。

## 4. 取舍（可推翻）

1. **consumer 自有端口、bootstrap 结构绑定，而不是给 memory 加 adapter**：memory 的对象已经满足端口，交接处由编译器检查；与 RFC-553 / RFC-558 同形。
2. **端口只写 consumer 用到的方法与字段**：task-execution 只用两个注入方法，蒸馏两边各只调一次 `enqueue`。

## 5. 对 RFC-294 刷新后规则的对账

- **C10**：端口归 consumer 的 `application/ports`。**C11**：task-execution 与 collaboration 的 public 不变（collaboration 的 `createTaskFeedback` 参数类型换成
  自有端口），memory 只撤出失去消费方的符号。**C12**：RFC-559 用例覆盖。**C13**：DAG 外 offered 边 44 → 35，其余计数不升。
