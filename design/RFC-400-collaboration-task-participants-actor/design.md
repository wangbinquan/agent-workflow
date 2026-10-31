# RFC-400 设计：collaboration 经 task 自有参与者写任务、人工门装配归位、public 合同去 legacy Actor

研究基线 HEAD `950f5900b`（行号只作定位提示，以实施时源码为准）。研究由 Codex 只读完成（2026-10-31，线程
`01a191b6-41cd-7630-95da-cb784aad7350`）。本会话对其中的关键论断逐条复核过源码，包括：COL→TE 实线边、`AuthenticatedAuthoritySnapshot`
与 `Actor` 字段等价、identity-access type-only 放行、能力规则、`acceptHumanGateDecisionTx` 为异步、装配桥的组成。在此基础上定稿。

缩写：`src/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`；TE = task-execution、COL = collaboration、
IA = identity-access、RM = runtime-management、KE = knowledge-evolution、SO = system-operations；`i/` = `infrastructure/`，
`a/` = `application/`。AAS = IA `public/participants.ts#AuthenticatedAuthoritySnapshot`。

## 1. 现状

### 1.1 COL → TE 内部文件对（17 对）

| 代号 | COL 调用点 | TE 内部文件与符号 | 所在事务 |
| --- | --- | --- | --- |
| E | `i/clarify/seal.ts`、`i/humanGateTerminalSweep.ts`、`i/taskQuestionDispatch.ts` | `i/taskLifecycleCommittedEvents.ts#appendTaskNodeStatusesCommittedEvent` | seal 的 `databaseSessionFor(db).transaction`（仅 `flipNow && decisionParticipant === undefined` 分支）；清扫自己的事务（无取消行时不追加）；派发写事务的无决定分支 |
| S | `i/clarify/service.ts`、`i/collaborationWorkgroupClarify.ts`、`i/review.ts` | `i/nodeRunLifecycleTransition.ts#setNodeRunStatusTx`、`transitionNodeRunStatusTx` | 跨澄清派发的 `withTaskExecutionWrite`；workgroup 澄清解除的事务；评审各分支自己的写事务 |
| D | `i/clarifyDecision.ts`、`i/review.ts`、`i/taskQuestionDispatch.ts` | `i/taskDecisionParticipant.ts#acceptHumanGateDecisionTx` | 封存决定参与者收到的 `sealed.tx`；评审决定写事务；派发事务（semaphore 内、task lock 后） |
| M | `i/review.ts`（空列表分支、rerun 循环）、`i/taskQuestionDispatch.ts`（每事务一个实例再循环 `.mint()`） | `i/nodeRunMintParticipant.ts#createNodeRunMintParticipantInTx` | 绑定当前 tx；构造位置与实例范围按原样 |
| M′ | `i/taskQuestionDispatch.ts`（事务外的 `FrontierMintPlan.input`） | `a/ports/nodeRunLifecyclePersistence.ts#NodeRunMintInput`（类型） | 计划在事务外生成，执行走 M |
| H | `i/review.ts`（空列表自动批准、`refreshAwaitingReview`） | `i/humanGateTaskTransition.ts#transitionHumanGateTask` | 原写事务 / task lock 之后 |
| L | `i/review.ts`（无可复用评审行） | `i/nodeRunLifecyclePersistence.ts#DrizzleNodeRunLifecyclePersistence` | **自行开启** aggregate 写事务 |
| A | `i/review.ts`（决定事务前的查询、事务内 task lock / 重读后的查询） | `i/taskAuthorization.ts#createTaskAuthorizationQueries`、`createTaskAuthorizationParticipantInTx` | 事务前 / 事务内各一处 |
| Q | `i/review.ts`（回滚准备）、`i/taskQuestionDispatch.ts`（`buildFrontierMintPlan`） | `a/nextRetryIndex.ts#nextRetryIndex` | 纯计算，事务外 |

按文件对计：`clarify/seal`→E、`clarify/service`→S、`clarifyDecision`→D、`collaborationWorkgroupClarify`→S、
`humanGateTerminalSweep`→E、`review`→Q/H/L/S/M/A/D（7 对）、`taskQuestionDispatch`→Q/M′/M/D/E（5 对），共 17 对。

### 1.2 `services/humanGateComposition.ts`

组合了：canonical request / hash 三个函数、`gateDecisionReceipt`、`decodeCollaborationCommittedEvent`、三组决定
manifest / receipt 编解码（clarify、question dispatch、review）、`createCollaborationCommandContext`（COL
`composition/commandContext.ts`）、`prepareWorkspaceRollbackPlan`（缺省 inspector 为调用时 `new GitWorkspaceRollbackSnapshotInspector()`）、
TE `public/commands#parkPreparedHumanGate`，以及七个 `*Bridge` 类型别名。消费者：COL `i/review.ts`、`i/clarify/autoDispatch.ts`、
`i/taskQuestionDispatch.ts`、`i/clarify/service.ts`、`i/taskQuestions.ts`。

九环（文件头记录）：`COL/composition.ts` → `collaborationRouteOperations.ts` / `collaborationRuntimeMechanics.ts` → `review.ts` /
`taskQuestions.ts` / `taskQuestionDispatch.ts` / `clarify/*` → `services/humanGateComposition.ts` → `COL/composition.ts`。

### 1.3 public 合同里的 legacy `Actor`

直接 import `@/auth/actor` 的 public 文件（8 个）与经 public 转出的 `application/ports` 声明（5 个）：

| 声明源 | 符号 | 主要消费者 |
| --- | --- | --- |
| `intent/public/operations.ts` | `canAuditIntentSessions` | `services/resourceAcl.ts`、intent session / routes |
| `intent/a/ports/intentApplyOperations.ts` | `IntentApplyOperations.apply.actor`（经 public operations 转出） | intent inbound、apply 引擎 / 装配 |
| `knowledge-evolution/public/participants.ts` | `FusionPersistence`、`FusionDecisionClaimInput`、`FusionApplyCommand`、`FusionOperations` 闭包 | KE 编排 / 仓储 / 路由 / 装配；经 public operations 到 `bootstrap/daemonApplication.ts`、`daemonSession.ts` |
| `memory/public/catalog.ts` | `MemoryScopeAuthority`（传递到 `MemoryCatalogQueries/Operations`、`public/operations#MemoryOperations`） | `routes/memories.ts`、KE fusion / provenance、SO overview |
| `task-execution/public/commands.ts` | `AgentRouteTaskLaunchOperations`、`WorkgroupRouteTaskLaunchOperations` | `routes/agents.ts`、`routes/workgroups.ts` |
| `task-execution/public/queries.ts` | `TaskOverviewQuery.load` | SO overview |
| `task-execution/public/taskRoutes.ts` | `TaskRouteOperations` | `routes/tasks.ts` 与 TE 实现 |
| `task-execution/a/ports/taskClarifyDirectiveRoutes.ts` | `TaskClarifyDirectiveRouteOperations.resolveAccess`（经 public types 转出） | `routes/taskClarifyDirective.ts`、COL adapter |
| `task-execution/a/ports/taskExecutionResourceSnapshots.ts` | `TaskExecutionResourceAuthorityPair`（经 public commands 转出） | launch / resource binding |
| `runtime-management/public/participants.ts` | `RealtimeChannelAccess`、`RealtimeRuntime`、`RealtimeCompositionPolicy`（`ActorSource`） | `ws/registry.ts`、`ws/server.ts`、RM 实现、bootstrap |
| `system-operations/public/queries.ts` | `SystemOverviewAuthority`、`SystemOverviewQuery` | `routes/overview.ts` |
| `integration/a/ports/scheduledTaskPersistence.ts` | `IntegrationOverviewQueries.countScheduled`（经 public queries 转出） | SO overview |
| `run-observability/a/ports/taskFacts.ts` | `ObservationTaskFactsPort`（经 public queries 转出） | 观察服务、TE provider |

## 2. 设计

### 2.0 通用形状

- **合同归 provider（TE），经实线边消费**：COL→TE 是 `OFFERED_CONTEXT_EDGES` 里的实线，COL 只 import TE exact
  `public/{participants,queries,commands}`。不另造 COL 的 required SPI，不新增 DAG 边。
- **带事务句柄的构造入口不进 public**：工厂在 TE `infrastructure/`，经 TE `composition.ts` 交给 bootstrap；bootstrap 把工厂
  **引用**交给 COL 的内部装配输入，COL 在原调用点、原时机调用。bootstrap 不提前创建查询对象、铸造持久化或 tx 参与者。
- **能力规则**：TE `public/participants.ts` 里名字匹配 `SENSITIVE_TYPE`（如 `*InTx`）的合同须 readonly、带同文件 `unique symbol`
  私有 brand、在 TE 内恰好一个 `create*` / `mint*` 工厂（返回该类型、函数体 `Object.freeze`、工厂所在文件有 `new WeakMap/WeakSet`
  注册表）。新合同按此实现，不靠改后缀或扩大 `CAPABILITY_COMPATIBILITY_DEBT` 绕过。
- **测试入口也显式提供依赖**，不加「缺省时直接 import provider」的分支。

### 2.1 Part A1：17 对改经 TE 自有参与者

新增（或补全）TE 合同，声明于 `TE/public/participants.ts`；工厂集中在新文件 `TE/i/humanGateTaskParticipants.ts`，委托现有实现，
原 SQL / program 留在原文件（减少对 `node-run-mint`、`rfc098-node-run-mint-grep-guard`、`rfc359-w47-node-run-mint-program`、
`lifecycle-grep-guard` 等语句级锁的扰动）：

| 代号 | TE public 合同 | TE 工厂（唯一 owner 工厂） | 委托 |
| --- | --- | --- | --- |
| E | `TaskNodeStatusEventsParticipantInTx` | `createTaskNodeStatusEventsParticipantInTx(tx)` | `appendTaskNodeStatusesCommittedEvent`；结果用既有 TE `TaskExecutionPostCommitEventRef`，不公开 platform `CommittedEventRef` |
| S | `HumanGateNodeRunStateParticipantInTx`（成员 `setNodeRunStatus` / `transitionNodeRunStatus`，与内核同名：RFC-317 转移表预言按被调名识别 CAS 站点） | `createHumanGateNodeRunStateParticipantInTx(tx)` | `setNodeRunStatusTx`、`transitionNodeRunStatusTx`（保留 `allowTerminal` 与错误文本） |
| D | `TaskDecisionParticipantInTx`（既有，改为 `Promise<AcceptedHumanGateDecision>`，补 brand / readonly / 工厂） | `createTaskDecisionParticipantInTx(tx)` | `acceptHumanGateDecisionTx` |
| M | `HumanGateNodeRunMintParticipantInTx` | `createHumanGateNodeRunMintParticipantInTx(tx)` | `createNodeRunMintParticipantInTx` |
| H | `HumanGateTaskTransitionParticipantInTx` | `createHumanGateTaskTransitionParticipantInTx(tx)` | `transitionHumanGateTask` |
| L | `HumanGateNodeRunMintOperations`（非 InTx：自行开写事务） | `createHumanGateNodeRunMintOperations(db)`（在原调用点构造） | `DrizzleNodeRunLifecyclePersistence` |
| A | 既有 `TaskAuthorizationQueries`、`AsyncTaskAuthorizationParticipantInTx` | 既有 `createTaskAuthorizationQueries(db)`、`createTaskAuthorizationParticipantInTx(tx)` | 不变，只改为经装配注入 |
| Q | `TE/public/queries.ts` 具名导出 `nextRetryIndex` | — | 原函数，同步调用 |

请求 DTO（含 `HumanGateNodeRunMintRequest`）放 `TE/a/ports/humanGateTaskParticipants.ts` 并经 public participants 转出。它保留调用实际
用到的身份、继承、覆盖与执行上下文字段，不直接公开带宽泛 `Partial` 闭包的 `NodeRunMintInput`。M′ 的事务外计划类型改用它。

**接线**：COL 新增内部装配输入 `COL/i/taskExecutionParticipantBindings.ts#TaskExecutionParticipantBindings`，字段是上表各工厂的函数
引用，返回 TE public 类型；TE 不反向 import 它。`bootstrap/crossContextClosure.ts` 持有工厂引用，沿 `daemonModules/taskExecution.ts`
（command / runtime / decision 构造）、`daemonHttpComposition.ts`（路由构造）、`daemonSession.ts`（终止清扫构造）注入；测试 helper 同步显式接线。

**必须保持**（逐条）：seal 的 `afterCommit` 仍是提交后第一个操作，任务事件 ordinal 0、COL 事件 ordinal 1；清扫的默认 reason 与
`terminal-sweep:${taskId}:${cause}`；`'cross-clarify-persistent-stop'`、`'wg-clarify-disabled'` 文本与逐次取时位置；D 在 journal
prepare / projection 之后、receipt / journal complete 之前；M 原来每次 / 每事务构造的位置照旧，不提升为整事务或会话共享；L 不改成
InTx、不嵌套；A 的事务前 / 事务内两处分开注入，保留 `.canActOnTask({ userId, taskId })`；Q 的 `{ topLevelOnly: true, iteration }`
参数与 ULID 分配次序。

### 2.2 Part A2：`services/humanGateComposition.ts` 退役

1. 五个消费者改为直接引用 COL domain 的定义（编解码、hash、receipt、事件解码），`parkPreparedHumanGate` 直接引用 TE
   `public/commands`；七个 `*Bridge` 别名删除，改用定义处类型。
2. `COL/composition/commandContext.ts` 拆成：
   - `COL/a/commandContext.ts`：依赖类型、**唯一** WeakMap 注册表、注册与 resolver；
   - `COL/i/collaborationCommandContext.ts`：原 adapter 构造代码（直接引用 `i/contentReviewArtifacts.ts`）；
   - `COL/composition.ts` 只给 bootstrap 导出构造函数；COL 实现文件引用上述定义文件，不回读 `composition.ts`。
3. `prepareWorkspaceRollbackPlan` 的缺省 inspector 仍在调用时 `input.inspector ?? new GitWorkspaceRollbackSnapshotInspector()`，
   放在 `COL/i/` 的包装里。
4. 删除旧桥与旧 `commandContext.ts`，不留转发层。

**必须保持**：command context 里**两个不同的** `DatabaseHumanGateOperationJournal`、各 adapter 的构造顺序、可选 artifacts 的惰性条件、
同一个 WeakMap 注册表（拆分后不得出现两份）；既有 lazy import 的时机。九环的两条回边（实现 → `services/humanGateComposition.ts` →
`COL/composition.ts`）随之消失；resolver 只依赖 application 叶子，构造只依赖 infrastructure 叶子；不新建
`composition/humanGateComposition.ts` 之类让实现继续回读总装配的文件。

### 2.3 Part B：public 合同去 legacy Actor

1. §1.3 的 13 个声明源把 `Actor` 换成 AAS，`ActorSource` 换成 `AAS['source']`；`canAuditIntentSessions` 只需 `Pick<AAS, 'permissions'>`。
   实现、路由与装配随之改标注。只换类型，不复制、不重新构造对象，不改变 `ReadonlySet` 或对象身份；调用形状不变。
2. KE 的 fusion 合同保留在 public，只换类型（`recoverFusionDecisions`、`reconcileFusion`、`reconcileRunningFusions`、
   `repairFusionProvenance`、`seedFusionResources` 的公开参数可达这些合同，不能只把类型内移）。
3. RM `RealtimeCompositionPolicy` 及其私有辅助接口移到 `RM/a/ports/realtimeCompositionPolicy.ts`，经 RM `composition.ts` 交给 bootstrap；
   `RealtimeChannelAccess` / `RealtimeRuntime` 留在 public，改用 AAS。
4. legacy `buildActor` / `Actor` 本身不动（路由与 legacy 服务仍在用，属 W9）；AAS 与 `Actor` 结构兼容，现有调用方传入的值无需转换。

### 2.4 账本与结构锁

- 预期：跨 context 内部文件对 73 → 56；越出 DAG 的 offered 54 不变；`PUBLIC_SURFACE_DEBT` 去掉 15 条 Actor / ActorSource 与
  `RealtimeCompositionPolicy` 的 2 条（137 → 约 120）；`CAPABILITY_COMPATIBILITY_DEBT` 去掉 `Actor leaks through public/types` 与
  `TaskDecisionParticipantInTx` 的三条缺口（22 → 约 18）；`commons-debt.json` R1 删去装配桥的约 9 条（229 → 约 220），R2 不变；
  横向文件 390 → 389、services 业务实现 219 → 218；RFC-310 manifest 预期零差异。扫描器按声明去重，归属标签可能随访问顺序换位，
  以完整候选实测为准，逐条核对，不只按条数删。
- `architecture/counts.json` 上限按实测压低；`T/architecture/rfc376-structural-guards.test.ts` 与 `T/rfc294-architecture-preflight.test.ts`
  的 17 对删除；`architectureReport.ts` 的 bridge owner 映射同步。
- 新增 `T/architecture/rfc400-collaboration-task-participants.test.ts`：COL→TE 内部对为 0；`services/humanGateComposition.ts` 不存在
  且无引用；COL 实现不 import 自己的 `composition.ts`；TE 带 tx 的构造入口不出现在 public；**追踪全部 public 导出签名的类型闭包**
  （含 operations、catalog、taskRoutes、别名与转导出），禁止可达 `@/auth/actor#Actor/ActorSource`。附负例：内部 import、隐藏的
  Actor 转导出、回读 composition 的回边。不改既有门的扫描范围迁就实现。

## 3. 测试

- 结构与账本：`T/architecture/` 整目录、`T/rfc294-architecture-preflight`、RFC-310 两个锁（`rfc310-architecture-lock`、
  `rfc310-digital-employee-os-architecture`）与其余根目录守卫——RFC-399 的教训是根目录下按路径或源码文本锚定的守卫最易漏，
  集中验证跑后端全量。
- command context 迁位：`rfc349-collaboration-route-operations`、`rfc359-w4-d26-adapters`、`rfc359-w12-collaboration-context-contracts`、
  `rfc395-wave2-followup-composition`。
- 夹具与负例：`rfc359-w55-clarify-execution-context`（改注入入口，保留显式 / ambient / 缺席三种 context）；
  `fixtures/rfc359-p0-mutations.ts`（变异靶点迁到真实新位置，负例仍能失败）。
- 语句顺序 / 唯一写入：`rfc333-human-gate-source-locks`、`rfc341-collaboration-source-locks`、`node-run-mint`、
  `rfc098-node-run-mint-grep-guard`、`rfc359-w47-node-run-mint-program`、`rfc326-tx-primitives-equivalence`、`lifecycle-grep-guard`、
  `rfc328TaskExecutionLedger`。
- Actor 标注：`rfc349-daemon-realtime-policy`、`rfc349-daemon-provider-core`、`rfc359-w12-realtime-composition`、
  `helpers/realtimeRuntime`，以及 fusion、overview、intent apply 的合同与对拍测试。
- `as never` 夹具：`helpers/productionTaskLaunch.ts`、`rfc287-t13-deferred-prep`、`rfc248-materialize-group`、
  `rfc359-w7-task-route-conformance`、`rfc359-w8-task-route-capability-parity`——新增依赖须在测试工厂显式接线并走到相关分支，
  不能只靠 tsc。
- 行为复用：`rfc359-t1/t2/t2b/t2c`、`rfc326`、`rfc333`、`rfc341` 与相关 RFC-395 双 provider 用例，重点证明同一 tx、整体回滚、
  提交后发布、构造次数与顺序。

## 4. 已知存量（不在本批）

- 其余经 `services/` 的间接跨域依赖（W9-D）；composition 子文件里的实现归层（S6）。
- legacy `Actor` 在路由、`services/` 与模块内部实现中的使用（W9）；本 RFC 只清 public 合同。

## 5. 风险

按严重度：把自行开事务的 L 误换成 InTx；改变 fence / task lock / 重读 / mint / journal 的次序；提前生成时间、ULID 或缺省 inspector；
拆 command context 时出现两份 WeakMap；把每调用 / 每事务构造的对象提升为会话单例；换 Actor 类型时顺带做对象转换。实现门逐条对照
§2.1、§2.2 的「必须保持」检视。
