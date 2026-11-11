# RFC-482 设计：事务参与者与三个小查询改经装配期绑定

落在 task-execution 与 collaboration 两个 bounded context，外加 bootstrap 的装配。不改任何参与者、查询与持久化的语义、SQL 和事务边界。

## 1. 现状（HEAD `68086c6cd`，源码实读与语法树普查）

| 符号                                        | task-execution 的交出口  | collaboration 的使用（文件 / 调用）                                                                                                          |
| ------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createHumanGatePersistenceParticipantInTx` | `public/participants.ts` | `review.ts` 7、`clarify/seal.ts`、`humanGateTerminalSweep.ts`、`reviewRepairParticipant.ts`、`taskCollab.ts`、`taskQuestionDispatch.ts` 各 1 |
| `createConsumedInputsParticipantInTx`       | `public/participants.ts` | `review.ts` 2（评审派发）                                                                                                                    |
| `reselectRunInTx`                           | `public/participants.ts` | `review.ts` 2（评审决定：sibling cascade 与本评审重开）                                                                                      |
| `createTaskClarifyDirectivePersistence`     | `public/participants.ts` | `taskClarifyDirective.ts` 5（五个转发函数）、`taskCollaborationReads.ts`、`workgroupTaskRoomClarifyParticipant.ts` 各 1                      |
| `createTaskSubjectQueries`                  | `public/queries.ts`      | `review.ts` 2（评审列表与详情）                                                                                                              |
| `createRunSelectionReader`                  | `public/queries.ts`      | `review.ts` 3、`taskDagCollaborationOperations.ts`、`taskQuestionDispatch.ts` 各 1                                                           |

- 合计 10 个文件、30 个调用点，全在 collaboration 的 infrastructure；模块外别无使用方（memory 与 bootstrap 不用这六个）。
- `PersistenceTx` 就是 `PersistenceDb`（`platform/persistence/querySurface.ts:248`），不少调用点传的是事务句柄：只能把**工厂引用**交给
  collaboration，不能在装配期用根 db 预先绑好实例——那会把事务里的读写换成事务外的连接。
- RFC-400 的先例：collaboration 在消费侧声明装配输入 `TaskExecutionParticipantBindings`（`infrastructure/taskExecutionParticipantBindings.ts`，
  工厂引用可以带持久化句柄），bootstrap 的 `composeTaskExecutionParticipantBindings`（`bootstrap/crossContextClosure.ts`）从 task-execution
  的 composition 取工厂交进来；task-execution 的 public 只交出参与者接口。它已经沿评审派发 / 决定、提问派发、反问决定、自动派发与运行时
  机制的调用链传到 11 个函数里。
- `reselectRunInTx`（`infrastructure/runSelection/selectionWrite.ts:42`）三个参数都不用、直接返回 `[]`，注释写明「重开只改状态，从不替换
  更新的持久选中」。`rfc395-a3-sites-b`、`rfc395-a3-oracle-query-cost` 断言它返回空数组。
- clarify 指令的读取绕一圈：引擎在 `engine/node/agent-single/runAgentSingleNode.ts:296`、`:577` 与
  `engine/node/clarify-cross-agent/runCrossClarifyNode.ts:88` 读指令，端口由 `composition/agentNodeExecution.ts:158`、
  `composition/humanGateNodeExecution.ts:90` 接到 `CollaborationRuntimeMechanics.getNodeClarifyDirective`
  （`application/ports/collaborationRuntimeMechanics.ts:178`）；collaboration 的实现（`infrastructure/collaborationRuntimeMechanics.ts:128`）调
  `taskClarifyDirective.ts` 的转发函数，再回到 task-execution 的 `createTaskClarifyDirectivePersistence(db)`。存储归 task-execution
  （RFC-395 A7，`infrastructure/taskClarifyDirectivePersistence.ts` 头注释）。
- 没有绑定在手、要沿调用链接上的函数（语法树普查，调用方在括号里）：`review.ts` 的 `deleteReviewCommentUnlocked`、
  `updateReviewCommentTextUnlocked`、`getReviewDetail`、`listReviewSummaries`（都经路由操作 `createCollaborationRouteOperations`，它的输入已有
  绑定）；`reviewRepairParticipant.ts` 的 `createReviewRepairParticipant`（← `composeCollaborationRepairPorts` ← bootstrap）；`taskCollab.ts` 的
  `updateTaskMembersLocked`（← `updateTaskMembers` ← `composeTaskMembershipOperations` / `composeTaskMembershipOperationsPort` ← bootstrap）；
  `taskQuestionDispatch.ts` 的 `buildFrontierMintPlan`（← `planDispatchFrontier` ← `dispatchTaskQuestionsLocked`，后者已有绑定）；
  `taskCollaborationReads.ts` 的 `createTaskArchiveCollaborationSectionReader`（← `composeTaskCollaborationReads` ← bootstrap）；
  `workgroupTaskRoomClarifyParticipant.ts` 的 `createWorkgroupTaskRoomClarifyParticipantInTx`（← `composeWorkgroupTaskRoomClarifyParticipantFactory`
  ← bootstrap）；指令转发函数的调用方 `workgroupClarifyAskGate.ts`（← `createWorkgroupClarifyAskGate` ← bootstrap）、
  `clarifyDirectiveStore.ts`（← `isTaskClarifySuppressed` 与 `createCollaborationCommandContext`）。
- 命令上下文里的指令存储：`createCollaborationCommandContext` 总在必填的 `persistence.clarifyDirectives` 里造一份指令存储，但读它的只有
  路由的查询入口与命令入口（`application/queryEntries.ts:46`、`application/commandEntries.ts:176`，经 `requireClarifyDirectiveStore`）；它的
  其余调用方（`createClarifyRound`、`createManualTaskQuestion`、评审派发与三个决定命令）不用它。上下文已有「可选能力」的做法：
  `reviewDecisions`、`questionDispatches`、`clarifyDecisions`、`taskExecutionReadModels` 是依赖对象的顶层可选字段，由组装路由上下文的
  bootstrap 交入，`CollaborationRouteContext` 以类型参数声明它带哪些能力（`public/types.ts:64`）。

## 2. 机制与落位

- **绑定**：`TaskExecutionParticipantBindings` 增加五个工厂引用（类型取 task-execution `public/types` 的接口）：

  ```ts
  readonly createHumanGatePersistenceParticipantInTx: (tx: PersistenceTx) => HumanGatePersistenceParticipantInTx
  readonly createConsumedInputsParticipantInTx: () => ConsumedInputsParticipantInTx<PersistenceTx>
  readonly createTaskClarifyDirectivePersistence: (db: PersistenceDb) => TaskClarifyDirectivePersistence
  readonly createTaskSubjectQueries: (db: PersistenceDb) => TaskSubjectQueries
  readonly createRunSelectionReader: (db: PersistenceDb) => TaskRunSelectionReads
  ```

  task-execution 的 composition 转出这五个工厂；bootstrap 的 `composeTaskExecutionParticipantBindings` 与用例的
  `tests/helpers/taskExecutionParticipantBindings.ts` 一起补上。调用点照旧传原来的句柄（事务里的仍传事务）。

- **传参**：已有绑定的函数直接用 `taskExecutionParticipants.<工厂>(handle)`；§1 列的没有绑定的函数各加一个绑定参数（有入参对象的加字段），
  由调用方传下去；bootstrap 里的五个装配点（`composeCollaborationRepairPorts`、`composeTaskMembershipOperations`、
  `composeTaskCollaborationReads`、`composeWorkgroupTaskRoomClarifyParticipantFactory`、`createWorkgroupClarifyAskGate`）改收绑定。
- **指令存储改为可选能力**：`clarifyDirectives` 从 `CollaborationPersistence` 挪到 `CollaborationCommandDependencies` 的顶层可选字段，
  `CollaborationRouteContext` 加上这项能力，`requireClarifyDirectiveStore` 要求带它的上下文；`createClarifyDirectiveStore` 改收
  task-execution 的指令持久化实例（它只在根 db 上读写，`set` 自己开事务），由 collaboration 的 composition 转出，bootstrap 组装路由上下文时用
  绑定造好交入。其余组装命令上下文的地方不再造它。
- **task-execution 的 public**：撤出这六个符号。参与者与查询的接口类型已在 public 的照旧（`HumanGatePersistenceParticipantInTx`、
  `ConsumedInputsParticipantInTx`、`TaskClarifyDirectivePersistence`、`TaskSubjectQueries`）；run selection 的读取在
  `application/ports/runSelection.ts` 声明闭合接口 `TaskRunSelectionReads`（`current`、`consumed`、`familyHistory` 三个方法，签名与表实现
  `TableRunSelectionReader` 的同名方法相同，后者 `extends` 它），从 `public/types` 交出。
- **删除空操作**：`reselectRunInTx` 与评审决定里的两处调用删掉；两个 RFC-395 用例里断言它返回空数组的部分随之去掉，重开前后
  `reader.current` 不变的断言保留。
- **引擎直接读自己的表**：`TaskExecutionPersistence` 增加 `clarifyDirectives: TaskClarifyDirectiveReads`（`application/ports/taskClarifyDirectivePersistence.ts`
  里声明，`get` 一个方法），`createTaskExecutionPersistence` 用 `createTaskClarifyDirectivePersistence(db)` 填上；两处引擎端口改接它；
  `CollaborationRuntimeMechanics` 去掉 `getNodeClarifyDirective`，collaboration 的实现随之删掉。读取用的仍是同一个根 db、同一条 SQL。
- **collaboration 的转发文件**：`infrastructure/taskClarifyDirective.ts` 删除，调用方改用绑定上的 `createTaskClarifyDirectivePersistence`。

## 3. 账本与计数

- `PUBLIC_SURFACE_DEBT`（`rfc294-architecture-preflight`）销 6 条；`public-surface-deviations` 74 → 68。
- 两个模块的未消费 public 符号保持 0：新交出的 `TaskRunSelectionReads` 由 collaboration 的绑定类型取用。
- 越 DAG 的 offered 文件对 47、跨 context 内部文件对 43 不变（collaboration → task-execution 在目标 DAG 内，取的是 exact public）。
- 先在 `tests/` 与 `scripts/` 里搜这六个名字、`taskClarifyDirective`、`getNodeClarifyDirective` 与 `familyHistory` 的文本断言（站点账本、
  栈帧正则、负对照字符串），随改动改写（RFC-480 / RFC-481 的教训：`tsc` 看不到）。

## 4. 用例

- **新增 RFC-482 用例**（`packages/backend/tests/rfc482-te-participant-bindings-boundary.test.ts`，登记 guard-manifest）：
  - task-execution 的 public 文件不导出这六个名字（值与类型、转出与运行时命名空间都认，带负对照）；
  - collaboration 的全部生产文件不从 task-execution 的任何入口取这五个工厂与 `reselectRunInTx`；
  - `TaskExecutionParticipantBindings` 有五个工厂成员，bootstrap 的绑定把它们取自 task-execution 的 composition；
  - 源码里不再声明 `reselectRunInTx`；collaboration 的 `taskClarifyDirective.ts` 不在；
  - `CollaborationRuntimeMechanics` 没有 `getNodeClarifyDirective`，task-execution 的引擎端口接的是持久化包的 `clarifyDirectives`；
  - `TaskRunSelectionReads` 是只有方法签名的闭合接口，从 `public/types` 交出。
- **行为**：`createTaskExecutionPersistence(db).clarifyDirectives.get` 读到 `set` 写入的指令、无行时为 `undefined`；指令、评审、提问、成员与
  归档的既有用例覆盖改接后的路径。
- **既有用例改动**：取这六个名字的用例改取 task-execution 的 composition 或定义处；调用 §1 末段那些函数的用例补传
  `tests/helpers/taskExecutionParticipantBindings.ts` 的绑定；两个 RFC-395 用例按 §2 调整。

## 5. 失败模式

- **事务里的读写换了连接**：绑定交的是工厂、不是实例，每个调用点仍用原来的句柄构造，事务边界不变。
- **漏传的调用链**：缺参数由 `tsc` 报出；模块外取 task-execution 这六个名字的残留由 RFC-482 用例报出。
- **文本断言的账本**：按 §3 末条先搜后改，集中验证先跑 `tests/architecture/` 与读源码文本的用例，再上全量；两边都超时的用例单独拿到真结果。
- **引擎读指令的时机**：此前经 collaboration 的运行时机制，用的是 bootstrap 交给它的根 db；改接后用 task-execution 持久化包的同一个根 db，
  SQL 与结果相同。

## 6. 实施中的细化

（实施后填写。）

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：新接口按内容落在 task-execution 的 `application/ports`；clarify 指令的读取回到存储的拥有者；collaboration 只剩自己的协作逻辑。
- **C11**：task-execution 的 public 撤 6 增 1（`TaskRunSelectionReads`，取代原先经工厂返回类型暴露的整个表读取器）；collaboration 的 public
  只是 `CollaborationRouteContext` 的能力参数多一项（`clarifyDirectives`）。
- **C12**：RFC-482 用例覆盖 task-execution 的全部 public 文件、collaboration 的全部生产文件与 bootstrap 的绑定。
- **C13**：触及的减速带收紧到实测。
- **取舍（可推翻）**：沿用 RFC-400 的绑定对象并扩充它，而不是另立一个只装查询的绑定（同一份装配输入、同一条传递路径）；`reselectRunInTx`
  删除而不是改经绑定（它没有效果）；三个行形状查询工厂留给下一步（§1 的普查：47 个函数手里没有绑定，宜单独设计传参与收窄）。
