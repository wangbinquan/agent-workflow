# RFC-481 设计：task-execution 自有人工门端口

落在 task-execution 与 collaboration 两个 bounded context。只挪类型声明与 import、删一个转手字段、改两个函数的参数形状，不改任何
行为与端口成员。

## 1. 现状（HEAD `c28b1a8d8`，架构报告与源码实读）

task-execution → collaboration 的 8 个文件，全部 type-only，经 collaboration 的 public 取 4 个类型：

| task-execution 文件                                  | 取的类型                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `application/parkTaskAtHumanGate.ts`                 | `PreparedHumanGateRef`                                            |
| `application/ports/humanGateTaskLifecycle.ts`        | `PreparedHumanGateRef`                                            |
| `composition/humanGate.ts`                           | `PreparedHumanGateRef`                                            |
| `application/ports/humanGateNodeExecution.ts`        | `CollaborationRuntimeMechanics`                                   |
| `composition/taskEngineRuntimeOptions.ts`            | `CollaborationRuntimeMechanics`、`TaskDagCollaborationOperations` |
| `infrastructure/taskExecutionRuntimeParticipants.ts` | `CollaborationRuntimeMechanics`、`TaskDagCollaborationOperations` |
| `infrastructure/taskRouteRepairOperations.ts`        | `CollaborationRuntimeMechanics`                                   |
| `infrastructure/taskRouteOperations.ts`              | `CollaborationRuntimeMechanics`、`CollaborationCommandContext`    |

- `PreparedHumanGateRef`（collaboration `domain/humanGateOperation.ts`）是五个字段的值（operation id、task id、门的种类、期望的任务
  修订号、清单摘要）。门的种类在 collaboration 是 `HumanGateKind`、在 task-execution 是 `TaskExecutionHumanGateKind`，取值相同
  （`review` / `clarify` / `questions`）。
- `CollaborationRuntimeMechanics`（collaboration `application/ports/collaborationRuntimeMechanics.ts`，185 行）：九个方法与它们的
  输入输出类型，只取 shared 的类型、task-execution 的 `TaskExecutionContextRef` 与上面的 `PreparedHumanGateRef`。
- `TaskDagCollaborationOperations` 与 `TaskDagOpenClarifyEvidence`（collaboration `application/ports/taskDagCollaborationOperations.ts`）：
  三个方法，只用 `ReadonlySet<string>`。
- `CollaborationCommandContext`：`TaskRouteOperationsDependencies.collaboration`。task-execution 不读这个字段；它由 bootstrap
  （`daemonModules/taskExecution.ts`）造好传入，经 `composition/providerRuntime.ts` 原样交回。

两个开放类型：`loadFrameChain(read: (nodeRunId) => Promise<…>, frame)`、`resolveSourceFrame({ …, containerRowById: (id) => … })`，模块外
唯一的使用方是 collaboration `infrastructure/review.ts` 取评审上游帧的一处。collaboration 的那一条：
`createTaskDeletionCollaborationParticipantInTx(tx: PersistenceTx)`，模块外唯一的使用方是 bootstrap。

## 2. 落位

| 声明                                                           | 原位置（collaboration）                               | 新位置（task-execution）                              | 依据                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PreparedHumanGateRef`                                         | `domain/humanGateOperation.ts`                        | `domain/humanGateContinuation.ts`                     | 纯值，与 `TaskExecutionHumanGateKind` 同处；门的种类改用 task-execution 的类型 |
| `CollaborationRuntimeMechanics` 与其输入输出类型               | `application/ports/collaborationRuntimeMechanics.ts`  | `application/ports/collaborationRuntimeMechanics.ts`  | task-execution 要求的端口；`TaskExecutionContextRef` 改取定义处                |
| `TaskDagCollaborationOperations`、`TaskDagOpenClarifyEvidence` | `application/ports/taskDagCollaborationOperations.ts` | `application/ports/taskDagCollaborationOperations.ts` | 调度器要求的端口                                                               |

- task-execution 的 `public/types.ts` 转出这三组类型，collaboration 的实现、用例与 domain 改取 `@/modules/task-execution/public/types`
  （collaboration → task-execution 在目标 DAG 内；domain 取别的模块的 public 类型不违反分层规则）。collaboration 的
  `preparedHumanGateRef()` 照旧构造这个值，返回 task-execution 的类型。
- 不走 `composition/required-ports.ts` 那条车道：它只放行实现方 `application/adapters/*-adapter.ts` 的 type import，而这两个端口的实现在
  collaboration 的 infrastructure 里、要用端口的输入输出类型，走车道只能在 adapter 里转出或复制一份同构类型。与 RFC-480 把
  `TerminalWorkspacePrunePolicy` 放进 `public/types` 同理。
- collaboration 的 `public/types` 与 `public/participants` 不再转出这三组（模块外无人再取，留着就是未消费符号）；collaboration 的两个
  端口文件删除。
- task-execution 路由依赖删去 `collaboration` 字段，`providerRuntime.ts` 的泛型参数与返回值里的这一项随之删去；bootstrap 在造它的地方
  直接持有并交给需要它的装配。
- 两个帧函数：`loadFrameChain(reader: ContainerRunReader, frame)`，`ContainerRunReader { read(nodeRunId): Promise<ContainerRunRow | null | undefined> }`；
  `resolveSourceFrame({ …, containerRows: ContainerRunLookup })`，`ContainerRunLookup { get(id): ContainerRunRow | undefined }`。模块内的
  `resolveSourceFrameInScope` 不在 public，保持函数参数，由 `resolveSourceFrame` 适配。两个接口只经这两个函数的签名进入公开合同，不单独
  交出名字（§6）。
- `createTaskDeletionCollaborationParticipantInTx` 改由 collaboration 的 `composition.ts` 转出，bootstrap 改取 composition；撤出
  `public/participants`。

## 3. 账本与计数

- `OFF_DAG_OFFERED_EDGE_DEBT`（`rfc294-review-offered-edge-dag`）销 task-execution → collaboration 的 8 条，`rfc376-structural-guards`
  的 committed baselines（`KNOWN`）删去同样的 8 行；`off-dag-offered-file-context-pairs` 55 → 47。
- `PUBLIC_SURFACE_DEBT`（`rfc294-architecture-preflight`）销 3 条；`public-surface-deviations` 77 → 74。
- 两个模块的未消费 public 符号保持 0：task-execution 新交出的类型都由 collaboration 取用（端口的输入输出类型经端口签名算作被消费）；
  collaboration 撤出的转出原本只有 task-execution 在取。
- 跨 context 内部文件对不变（43）：新增的 import 全是 exact public 入口。

## 4. 用例

- **新增 RFC-481 用例**（`packages/backend/tests/rfc481-te-human-gate-port-boundary.test.ts`，登记 guard-manifest）：
  - task-execution 的全部生产文件里指向 collaboration 的引用精确等于 required-SPI 车道那一条（`application/adapters/collaboration-adapter.ts`
    取 collaboration 的 `composition/required-ports`；静态、re-export、type、动态 import 与 require 都认；带负对照）；
  - 三组端口类型在 task-execution 的新位置导出、从 `public/types` 交出，collaboration 的任何文件不再声明它们，collaboration 的 public 不再
    交出它们；
  - 两个帧函数的公开签名里没有函数类型的参数（语法树判定，带负对照），collaboration 的使用处传的是带方法的对象；
  - collaboration 的删除参与者工厂由 `composition.ts` 交出、不在 public，bootstrap 取 composition；
  - task-execution 路由依赖里没有 `collaboration` 字段。
- **账本与用例改指**：上面两本账、`counts.json`、guard-manifest；按 RFC-480 的教训，先在 `tests/` 与 `scripts/` 里搜这些类型名、文件路径与
  栈帧路径的文本断言，随挪位改写（`tsc` 看不到）。

## 5. 失败模式

- **结构同构的两份类型**：不保留 collaboration 那份，collaboration 的 `HumanGateKind` 与 task-execution 的 `TaskExecutionHumanGateKind`
  取值相同，`PreparedHumanGateRef` 只有一份定义。
- **转手字段删掉后 bootstrap 取不到协作上下文**：bootstrap 的两处取用方读的是 bootstrap 模块自己返回的 `collaboration`——它在
  `{ ...provider, …, collaboration }` 里本来就覆盖了 provider 转手的那一份（同一个对象），删掉转手不影响它们。
- **账本漏改**：按 RFC-480 的教训，集中验证先跑 `tests/architecture/` 与读源码文本的用例，再上全量；两边都超时的用例单独拿到真结果。

## 6. 实施中的细化

- `FrameChain` 的函数型字段 `lookup` 删去：调用方改用 `rows`（`ReadonlyMap` 满足 `ContainerRunLookup`）；`resolveSourceFrameInScope` 不在
  public，保留函数参数，由 `resolveSourceFrame` 适配。
- 撤出的连锁：collaboration `public/types` 的 `HumanGateKind` 只因被 `PreparedHumanGateRef` 引用才算被消费，`public/participants` 的
  `TaskDeletionCollaborationParticipant` 只是删除工厂的返回类型，两者随之撤出（否则成为未消费符号）。
- 两个帧接口不单独从 `public/queries` 交出：collaboration 传的是对象字面量、不按名字取用；与下一条里端口其余的输入输出类型同一做法，public
  只加对方按名字取用的（C11），其余只经签名进入公开合同。
- task-execution `public/types` 只交出 collaboration 按名字取用的 7 个类型；`CollaborationRuntimeMechanics` 其余的输入输出类型只经端口签名
  引用，留在 task-execution 内部。
- 用例改动：`rfc359-w12-collaboration-context-contracts` 里「provider 只用读模型能力并原样交回调用方的协作上下文」那一段前提不在，改为类型层的
  缺席断言（provider 的路由依赖与运行时都没有 `collaboration` 键）；`rfc476` 断言 bootstrap 取删除工厂的来源改为 composition；
  `rfc349-collaboration-runtime-mechanics` 读端口契约的路径改为 task-execution；`rfc354-environment-chain` 的 `resolveSourceFrame` 调用改传
  `containerRows`；9 个用例与一个 helper 改取删除工厂的定义处；provider 用例 helper 的路由依赖删去占位的 `collaboration`。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：端口与值按内容落在 task-execution 的 application/ports 与 domain。
- **C11**：task-execution 的 public 新增的只是要求对方实现的端口类型与一个值，不是内部构件；collaboration 的 public 只撤不增。
- **C12**：RFC-481 用例覆盖 task-execution 的全部生产文件（指向 collaboration 的只剩 required-SPI 车道）与两个模块的 public 文件。
- **C13**：触及的两项减速带收紧到实测。
- **取舍（可推翻）**：类型名不改（描述的是 task-execution 要求的协作能力）；端口经 `public/types` 交出而不走 required-ports 车道（§2）。
