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
  其余调用方（`createClarifyRound`、`createManualTaskQuestion`、评审派发与三个决定命令）不用它；这两个入口唯一的使用方是 bootstrap 组装的
  指令路由操作适配器 `composeTaskClarifyDirectiveRouteOperations`（`application/adapters/task-execution-adapter.ts`）。

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
- **指令存储直接交给用它的适配器**：命令上下文不再带指令存储（`CollaborationPersistence.clarifyDirectives` 与
  `requireClarifyDirectiveStore` 删除）；`composeTaskClarifyDirectiveRouteOperations` 多收一个 `ClarifyDirectiveStore` 参数，两个入口改收这个
  端口而不是上下文。`createClarifyDirectiveStore` 改收 task-execution 的指令持久化实例（它只在根 db 上读写，`set` 自己开事务），由
  collaboration 的 composition 转出，bootstrap 用绑定造好交给适配器。这样不增加可空依赖与「not composed」的运行期兜底（§6）。
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

- **两处死代码随之删除**：`taskCollaborationReads.ts` 的 `createTaskArchiveCollaborationSections` 自 RFC-395 II-b 起全仓零调用（它是
  `createTaskArchiveCollaborationSectionReader` 在本 RFC 改签名时唯一的另一个使用方），连同只被它用的端口类型
  `ArchiveCollaborationSections` 一起删掉，不为它改签名。
- **撤出的连锁**：`ShardSetView`（task-execution `public/queries`）只经表读取器工厂的返回类型被消费，工厂撤出后成为未消费符号
  （架构报告 `unconsumed-public-symbols-task-execution` 0 → 1），随之撤出；模块外无人按名字取它。
- **引擎端口的分组**：指令读取不是协作能力，从 agent 节点端口的 `collaboration` 分组移出，成为 `AgentNodeExecutionPorts.clarifyDirectives`；
  跨澄清节点端口同样改为 `clarifyDirectives`，不再从 `CollaborationRuntimeMechanics` 推导类型。`CollaborationClarifyDirectiveInput` 随端口成员
  一起删除。
- **指令存储不做成上下文的可选能力**：起初照 `reviewDecisions` 等四项把它做成命令上下文的可选能力（路由上下文加一项、入口要求带它的
  上下文），集中验证时 `rfc359-w5-t19b-composition-root-complete` 报 `commandContext.ts` 的「not composed」兜底 5 → 6——这个守卫只降不升，
  RFC-359 W5-T19b 正是把可空依赖改成必填才降到 5。改为把存储直接交给唯一用它的适配器后，上下文没有新的可空依赖，命令上下文与路由上下文
  的公开类型都不变。
- **用例侧**：调用新加了绑定参数的函数的用例由语法树 codemod 补传 `tests/helpers/taskExecutionParticipantBindings.ts` 的绑定（只改从
  collaboration 模块 import 的那个函数的直接调用）；直接读写指令的用例改取新 helper `tests/helpers/clarifyDirectives.ts`（同样五个函数，
  落在 task-execution 的指令持久化上）；取被撤五个工厂的用例改取 task-execution 的 composition。
- **tsc 看不到的文本与哈希账本**（按 §3 末条先搜后改）：`rfc395-selection-semantics-ledger` 的三条 `familyHistory` 站点 `source`（调用文本多了
  绑定这一层接收者）；`rfc395-serialized-insert-source-locks.json` 里 `clarify/seal.ts` 的 sha256（评审说明随附）；`rfc359-t7e` 断言 bootstrap
  源码里问询门的调用写法；`rfc395-clarify-answer-boundary` 断言 `seal.ts` 在 seal 事务里构造人工门持久化参与者的那一行（改成容忍空白的
  正则）；RFC-442 用例断言 collaboration 的指令转发文件存在（改为断言它不在、并在 `clarifyDirectiveStore.ts` 上检查同一判据）。
  P0 变异 fixture 的各处锚点文本逐条核对仍各出现一次，问询门变异是零参函数，不受新参数影响。全量里又红了 8 个读源码的用例，同样随改动
  改写：引擎读指令的旧调用文本（`rfc122` 两条、`rfc123` 的跨澄清短路与 `resolveCrossNodeStopped`、`cross-clarify-stop-directive-scoped-to-cci-rerun`、
  `scheduler-cross-clarify-no-runaway`）改断言 `clarifyDirectives.get(…)`，读点位置的判据不变；seal 事务里的指令写点（`rfc123`、`rfc341`）改断言
  经绑定构造的 `.createTaskClarifyDirectivePersistence(tx)`，仍在事务内、`afterCommit` 之前、只有一处；`rfc349` 断言评审修复参与者与 bootstrap
  修复端口的调用写法；`rfc476` 的正对照取的正是被撤的 `createConsumedInputsParticipantInTx`，改用仍交出的 `prepareConsumedInputs`；
  `rfc395-a3-site-regressions` 从 `review.ts` 抠出 `coversSource` 的函数体执行，绑定的自由变量改为 `args.taskExecutionParticipants`。随后用字面量
  扫描对 HEAD 与候选比了一遍（做法见 `docs/dev-gotchas.md`），余下的命中都是模块名一类的通用词或本 RFC 新写的断言。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：新接口按内容落在 task-execution 的 `application/ports`；clarify 指令的读取回到存储的拥有者；collaboration 只剩自己的协作逻辑。
- **C11**：task-execution 的 public 撤 6 增 1（`TaskRunSelectionReads`，取代原先经工厂返回类型暴露的整个表读取器），随之撤出只经那个工厂
  返回类型可达的 `ShardSetView`；collaboration 的 public 不变。
- **C12**：RFC-482 用例覆盖 task-execution 的全部 public 文件、collaboration 的全部生产文件与 bootstrap 的绑定。
- **C13**：触及的减速带收紧到实测。
- **取舍（可推翻）**：沿用 RFC-400 的绑定对象并扩充它，而不是另立一个只装查询的绑定（同一份装配输入、同一条传递路径）；`reselectRunInTx`
  删除而不是改经绑定（它没有效果）；三个行形状查询工厂留给下一步（§1 的普查：47 个函数手里没有绑定，宜单独设计传参与收窄）。
