# RFC-480 技术设计

落在 task-execution 与 collaboration 两个 bounded context 的 `public/` 面及其内部各层；另改 bootstrap 一处 import、integration 两处 type
import、架构守卫（未消费符号按 context 分项）与 `architecture/counts.json`。数字取 HEAD `673b1b53b`（架构报告：task-execution 181、
collaboration 24 个未消费 public 符号）。不改行为。

## 1. 撤出规则

对两个模块里架构报告判为「未消费」的每个 public 符号（`unconsumedPublicSymbols`：没有模块外生产 import、没有模块外生产消费方、没有被
其他 public 符号的签名引用）：

| 情形                                           | 个数 | 做法                                                                            |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| 转出（`export { x } from '../…'`）             | 136  | 删掉转出；经 public 取用它的本模块文件与用例改取定义处                          |
| 直接声明在 public 文件里、没有任何使用方       | 31   | 删除声明（同一 public 文件里还被别的导出用到的，按下一行处理）                  |
| 直接声明在 public 文件里、只有本模块或用例在用 | 38   | 按函数体 / 类型的内容（C10）挪进模块内部对应的层，使用方改取新位置；落位表见 §2 |

撤出会让「只被同一文件其他导出的签名引用」的符号变成未消费（例如 `public/operations` 里的 `TaskStatusUpdateExtra` 只被 `trySetTaskStatus`
的签名引用）。实施按「撤出 → 复采 → 再撤」迭代到两个模块的未消费计数为 0（RFC-478 集中验证第 2 处是同一现象）。

**实测**：三轮复采后两个模块为 0。九个 public 文件共撤出 218 个名字（task-execution 189、collaboration 29，逐名清单
`packages/backend/tests/fixtures/rfc480-withdrawn-public-symbols.json`，以 `673b1b53b` 的导出为基准）；连锁带出的有
`TaskDriveCompletionMode`、`PortArchiveItem`、`UploadLimits`、`WebhookTerminalCause`（转出）与 `TaskExecutionCommandErrorCode`、
`TaskWorkspaceCommit*Result`、`LoopExitConditionCandidate`（声明）。`public/operations` 整体退役，不进清单。

只被用例经 public 取用的符号，按定义处的性质改：生产代码（只是没有模块外生产消费方）留在模块内部、用例改取定义处；只为用例存在的辅助
挪到 `tests/helpers/`。命名空间形式取 public 的用例（`import * as … from '…/public/…'`，用来断言某个名字已撤出）照旧可用；
`public/operations.ts` 删除后，取它的命名空间断言改为断言文件不在。

## 2. 直接声明在 public 的落位（按内容）

按函数体 / 类型实际取的依赖定层（C10）。collaboration 的 17 个用例函数的函数体只取命令上下文里已装配的端口与 application 用例类，没有一个
取 infrastructure，所以全部进 `application/`（设计时预留的「原样进 infrastructure」一档没有用上）。

| 原位置                                             | 声明                                                                                                                                                                                                                                     | 落位                                                                               | 依据                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| collaboration `public/commands`                    | `prepareReviewGateOpen`、`prepareClarifyGateOpen`、`createManualQuestionOpen`、`finalizeCommittedHumanGate`、`submitReviewDecision`、`dispatchTaskQuestions`、`submitClarifyDecision`、`setCollaborationClarifyDirective` 与三个回执类型 | `application/commandEntries.ts`                                                    | 经 `commandContext` 取端口、调 application 用例                                                              |
| collaboration `public/queries`                     | `resolveCollaborationNodeRunTaskAccess`、`resolveCollaborationClarifyTaskAccess`、`visibleCollaborationTaskIds`、`collaborationQuestionTaskId`、`listCollaborationClarifyDirectives`                                                     | `application/queryEntries.ts`                                                      | 同上（只读）                                                                                                 |
| collaboration `public/queries` / `public/commands` | `getReviewNodeReviewerConfig`、`resolveReviewAccess`、`filterReviewSummariesForActor`、`replaceReviewNodeReviewers`                                                                                                                      | `application/reviewNodeReviewerEntries.ts`                                         | 同上；连同原 `composition/reviewNodeReviewerDependencies.ts`（只从上下文取已装配端口、不构造实现），文件删除 |
| collaboration `public/types`                       | `CollaborationHumanInputQueries`                                                                                                                                                                                                         | `application/ports/humanInputQueries.ts`                                           | infrastructure 实现的读端口；development-automation 自有端口（`GraphHumanInputFacts`），不点名它             |
| task-execution `public/commands`                   | `WorkgroupTurn*` 7 个、`WorkgroupHostLedger*` 8 个                                                                                                                                                                                       | `application/ports/workgroupTurnsOperations.ts`                                    | 工作组轮次命令与主机账本的端口类型（该文件原本只是从 public 转出它们）                                       |
| task-execution `public/commands`                   | `TaskCancellationCommand`                                                                                                                                                                                                                | `application/ports/taskCancellationCommand.ts`                                     | infrastructure 实现、composition 装配的端口                                                                  |
| task-execution `public/events`                     | `TASK_LIFECYCLE_SOURCE_REF`、`TASK_STATUS_CHANGED_EVENT_REF`、`taskLifecycleObservation`                                                                                                                                                 | `application/taskLifecycleEvents.ts`                                               | 生命周期到事件观测的映射；`public/events` 仍取两个 ref 拼它交出的事件目录                                    |
| task-execution `public/participants`               | `SchedulerRuntimeTopology`                                                                                                                                                                                                               | `application/ports/taskExecutionTopology.ts`                                       | 与 `SchedulerDriverPort` 同处                                                                                |
| task-execution `public/participants`               | `WorkerIdentity`、`OwnedTaskTx`（连同两个 brand）                                                                                                                                                                                        | `domain/ownership.ts`                                                              | 所有权能力标识（纯类型）                                                                                     |
| task-execution `public/types`                      | `EmployeeExecutionArtifactQueries`                                                                                                                                                                                                       | `application/ports/employeeExecutionArtifactQueries.ts`                            | infrastructure 实现的读端口；development-automation 自有端口（`GraphExecutionFacts`）                        |
| task-execution `public/types`                      | `TaskExecutionCommandErrorCode`                                                                                                                                                                                                          | `application/taskExecutionError.ts`                                                | 唯一读者 `TaskExecutionError`                                                                                |
| task-execution `public/types`                      | `WrapperExecutionKind` / `…ScopeSegment` / `…Scope` / `…ScopeReadModel`                                                                                                                                                                  | 删除；执行状态改取 engine 消费方自有的 `WrapperScopeReadModel`                     | 与 `engine/node/wrapperDelegatingNodeExecutors.ts` 的读模型结构同构的副本                                    |
| task-execution `public/queries`                    | `wrapperInnerDescendantIds`                                                                                                                                                                                                              | 删除；`application/recovery/runLiveness.ts` 取 domain 的 `wrapperInnerDescendants` | 只是包了一层 domain 纯函数                                                                                   |

没有任何使用方、直接删除的：collaboration `readCollaborationHumanInputs`、`readCollaborationReviewDecision`；task-execution
`requireSchedulerDriver`、`CodeHostSendAttemptHandle`（别名）、`CodeHostSendAttemptSettlement`（与 `application/codeHostEffectObserver.ts`
那份逐字同构）、`TaskWorkspaceCommitParticipant` 及其三个结果类型、`isValidLoopExitCondition` 与 `LoopExitConditionCandidate`、
`TaskExecutionCommandResult`；`public/participants` 里失去模块外读者的 `export const X = XInternal` 别名（如 `TaskExecutionError`）删除，
本模块与用例改取定义处。其中 `createProcessEffectAttemptObserver` 别名指向的 `composition/processEffectObserver.ts`（本地默认 projection
的兼容装配）此后只剩两个用例在用——生产侧的本地 / CrewStation 运行器各自把 projection 交给 `application/processEffectObserver`——按 §1 的
规则挪到 `packages/backend/tests/helpers/localProcessEffectObserver.ts`，Windows workflow 的路径过滤随之改指；不挪的话它会成为一个不可达的
生产文件（`unreachable-production-files` 18 → 19）。

**实施中纠正的一处误判**：初次采数时报告的类型形状遍历不进 `readonly X[]`、元组与泛型实参，于是被另一个 public 签名以这些形式引用的
符号被误判为未消费（`WorkgroupTaskRoomOpenSelfClarifyPark`、`WorkgroupTaskRoomHostRunSnapshot` 两个曾被挪走后又恢复）。
`architectureReport.ts` 的 `collectTypeShape` 改为同时走 `TypeOperator`、`TupleType` 与泛型实参。修正后重采，其他 context 的未消费计数
117 → 91（这些 context 的 public 文件本 RFC 没有改；差值是误报消除与转出改指的合计，不逐项归因）。

## 3. task-execution `public/operations` 退役

- 25 个零消费导出与 3 个只被签名引用的类型随撤出规则撤掉。
- `assertNodeRunSourceTerminationAdmission`：collaboration `infrastructure/review.ts` 改取定义处 `@/platform/persistence/nodeRunLifecycleCore`
  （模块取 platform 是允许的方向；task-execution 的转出删掉）。
- `TerminalWorkspacePrunePolicy` / `TerminalWorkspacePruneDecision`：task-execution 要求外部实现的策略（consumer-owned 合同），挪进
  task-execution `public/types`（只有类型），integration 的 `application/` 与 `composition/` 改取它。不放 `composition/required-ports.ts`：
  `cross-context-internal-file-pairs` 只豁免 `application/adapters/*-adapter` 对它的 type import，integration 的两个文件取它会多出两条
  跨 context 内部文件对；consumer-owned 合同经 public 交出是本仓既有的 required SPI 形状。
- `registerTerminalWorkspacePrunePolicy`：由 task-execution 的 `composition.ts` 交出，bootstrap 改取 composition（bootstrap 取模块 composition
  是装配方向）。进程级注册表原样保留（S12）。
- `public/operations.ts` 删除；census 的 exact public 入口清单里它仍是合法入口名（其他模块还在用），不改。
- **偏差账本**：`publicSurfaceViolations` 按 RFC-344 把 `public/operations` 当操作描述入口整体豁免，task-execution 这份借了豁免——
  `TerminalWorkspacePrunePolicy` 是函数类型，换到 `public/types` 后第一次被扫到（同一合同、旧债可见，不是新增）。`PUBLIC_SURFACE_DEBT`
  登记这一条并写明出处（S12 改装配期注入时清偿），同时删去随撤出不再可达的 12 条；`public-surface-deviations` 88 → 77。

## 4. 未消费符号按 context 分项

`publicContractGateSets` 把 `unconsumed-public-symbols` 一项改成每个有 public 面的 context 一项 `unconsumed-public-symbols-<context>`
（含计数为 0 的 context），条目照旧是 public 条目 id；`architecture/counts.json` 删去总数一项、登记各项（上限 = 实测，RFC-479 的门要求
相等）。新增一个有 public 面的 context 会报 `missing count`。`public-surface-deviations` 仍是一项总数（S9 的类型污染清偿还没开始按模块推进）。

**实测**：19 个 context 有 public 面；task-execution、collaboration、intent、knowledge-evolution、run-observability、task-catalog、
workspace-insight 为 0，其余 12 个合计 91（system-operations 17、digital-employee 13、resource-catalog 12、identity-access 9、
source-control 9、development-automation 8、integration 8、code-capability 5、event-center 4、memory 3、execution-contract 2、
runtime-management 1）。`rfc376-report` 的计数项断言改为「21 + 偏差 1 + 每个 composition 模块一项 + 每个有 public 面的 context 一项」，
并逐 context 核对分项与报告章节相等；RFC-479 用例的两处口径断言随 id 改名。

## 5. 用例与账本

- **新增 RFC-480 用例**（`packages/backend/tests/rfc480-te-collaboration-public-lock.test.ts`，登记 guard-manifest，语料下限 1500）：
  `modules/task-execution/public/operations.ts` 不在、src / 用例 / 脚本零 import；被撤的符号不在两个模块的 public
  导出里（逐名，带一个仍在的正对照）；§2 挪走的声明在新位置导出、不再在 public 声明；三处模块外使用取新位置；§2 末段那处判据修正的
  回归：public 合同只经 `readonly X[]`、元组、泛型实参或索引访问引用的类型算作被消费（fixture，负对照是真正没人取用的类型仍计入；
  对修正前的报告代码跑，这五种形式各漏一个类型）。
- **用例改指**：经 public 取用被撤符号的用例改取定义处（codemod，按符号逐个解析定义处）；取 `public/operations` 命名空间的用例改为断言
  文件不在。
- **断言源码文本的用例随撤出改写**（`tsc` 看不到，集中验证的全量里查出）：`rfc345-workgroup-turns-provider-neutral`（轮次合同改在
  application 端口声明，`public/commands` 不再出现）、`rfc349-provider-cutover`（`PROVIDER_SPECIFIC_BUSINESS_DEPENDENCY_DEBT` 销掉
  `public/participants` 取 SQLite 执行上下文那条）、`rfc359-converged-twins`（`humanGateNodeProjectionMember` 的消费方白名单剪掉
  `public/participants`）、`rfc473-execution-outcome-and-resource-sessions`（正对照改取仍留在 public 的一项）、`rfc317-module-boundary`
  （public 入口的开放 Record 账本 `OPEN_RECORD_SITES` 销掉 task-execution `public/commands` 那条：工作组轮次结果的 `outputs` 随轮次合同
  进了 application 端口）、`rfc310-digital-employee-os-architecture`（它读的 RFC-310 `os-architecture-manifest.json` 里，取 event-center
  `public/types` 的 task-execution 文件由 `public/events.ts` 改为 `application/taskLifecycleEvents.ts`）、`rfc333-human-gate-source-locks`
  （续跑准入的唯一权威改为锁 `infrastructure/taskContinuationAdmission.ts` 的定义，`public/participants` 不再转出它）。
- **CI 查出的两处**（`bb7da0e8d` 的主 CI）：`rfc294Gates.ts` 的 capability owner 登记照 RFC-363 先例写明 task-execution `domain/ownership`
  的 `WorkerIdentity` / `OwnedTaskTx`（挪位后它们不再声明在 `public/participants`，原本合规的两个工厂被当成伪造），preflight 加 fixture 锁住
  规则在新位置照旧作用、例外只认这个文件；`scripts/rfc359-p0-mutations.ts` 里 p0-8 的栈帧证据与指纹清单改指 `application/commandEntries.ts`，
  `rfc359-w14-p0-mutation-verdict` 的转录与负对照随之改指。
- **账本**：`counts.json` 的分项与收紧；public surface、未消费、偏差三个报告数随实测变化；`PUBLIC_SURFACE_DEBT`（rfc294-architecture-preflight）
  删 12 条、加 1 条（§3）；guard-manifest 登记新用例并刷新改到的守卫行数。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：§2 的落位按内容：按函数体 / 类型实际取的依赖，全部落在 application（含 `application/ports`）与 domain，没有原样进
  infrastructure 的；两个被删的声明的使用方改取 engine / domain 的自有定义。
- **C11**：public 只撤不增——策略类型从 `public/operations` 换到 `public/types`（同一个合同、同一个消费方），composition 多一个转出
  （不是 `public/` 入口）。
- **C12**：RFC-480 用例的覆盖范围：文件不在与零 import 覆盖 backend 的 src / 用例 / 脚本；撤出断言覆盖两个模块的全部 public 文件；
  未消费符号的分项计数覆盖全部 context（全仓门）；类型形状遍历的回归只在 fixture 上判定。
- **C13**：触及的减速带（未消费分项、`legacy-*` 若有变化）收紧到实测——RFC-479 起由门强制。

## 7. 失败模式

- **撤出连锁**：见 §1 的迭代。
- **命名空间断言失效**：`'x' in ns` 形式的断言在被撤符号上本来就该为 `false`，不受影响；只有取已删文件的命名空间 import 要改。
- **挪走的声明换层后越界**：挪进 `application/` 的取了 infrastructure 会被 `module-layer-violations` 与 RFC-294 的层规则报出——按依赖定层
  （§2）避免。

## 8. 测试策略

- 行为不变：两模块的既有用例（评审、反问、问题派发、工作组主机账本、取消、终态回收）改取新位置后照旧通过。
- RFC-480 用例见 §5；分项计数由减速带用例与 RFC-479 用例的口径断言守住；`rfc376-report` 的计数项数断言随分项改写（按结构）。
