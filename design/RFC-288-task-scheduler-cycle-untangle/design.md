# RFC-288 — 技术设计（design，2026-08-14 第三轮门后修订）

> **本 RFC 已于 2026-08-14 CLOSED（未实现）**——理由与「必须带走的九条结论」见
> `proposal.md` 顶部。解环工作归 RFC-294 §16.2 / W2。本文保留作为那次实现的输入，
> 但**所有行级锚已按 `6e8c4f9f` 冻结、不再维护**，开工时须现扫。

> **锚约定**：全部源码锚写成 **`6e8c4f9f:path:line`**（评审基线 commit），不是「当前
> HEAD」。实现期每批第一子任务=逐锚复核，锚漂时更新 SHA 前缀。
> **RFC-294 对齐 pin：`be31dd62`**（其三件套目前唯一提交；主工作树另有未提交重写稿，
> 本文不依赖它）。

## 1. 环地图（基线 `6e8c4f9f` 实测）

### 1.1 主 8 环

值级成员：`task` / `scheduler` / `execution.executor` / `execution.outcome` /
`agentLaunch` / `workgroup.launch` / `gc` / `structuralDiff.callGraph.expandService`。
含 type 边为 10（`launchMultipart`、`execution/types` 仅 `import type`，被
`.dependency-cruiser.cjs:137` 的 `viaOnly.dependencyTypesNot: ['type-only']` 豁免；
**风险登记**：任一改成值 import ⇒ SCC=10 + 门禁新红）。

| 边 | 锚（`6e8c4f9f:packages/backend/src/`） | 说明 |
| --- | --- | --- |
| A1 `task → scheduler` | `services/task.ts:153` | 8-SCC 内**唯一闭环上行边**（不是全仓唯一 importer，见 §6） |
| B1 静态 | `services/scheduler.ts:205` | `emitTaskStatus`/`getTask`，全环最薄边 |
| B2/B3/B4 动态 | `services/scheduler.ts:3485 / 3526 / 3547` | `cancelTask` / `resumeTask` / `isTaskActive` |
| C1 动态 | `services/scheduler.ts:3982` | `startExecution` |
| C2 动态 | `services/scheduler.ts:4181` | `startWorkgroupTaskFromFrozen`——facade 旁路 |
| C3 静态 | `services/scheduler.ts:258` | `getExecutionOutcome`，方向正确 |
| D 组 | `services/execution/executor.ts:21/22/23/26`、`execution/outcome.ts:25`、`agentLaunch.ts:34-39`、`workgroup/launch.ts:45` | 启动臂；含 D7 单常量 `AGENT_HOST_AGENT_NODE_ID`（定义 `agentLaunch.ts:60`，消费 `outcome.ts:25,160`） |
| E1 `task → gc` | `services/task.ts:100` | **双符号**：`materializingSpaces` + `finishClaimedWebhookWorkspacePrune` |
| E2 `gc → expandService` | `services/gc.ts:36` | 方向正确，保留 |
| E3 `expandService → task` | `services/structuralDiff/callGraph/expandService.ts:12` | `getTask` |

七环 → 六条账映射（替代初稿引用的、并不存在的「测绘 §2.3」）：

| # | 账目 `(rule, from, to)` | witness |
| --- | --- | --- |
| 1 | `no-circular, scheduler, task` | `task → scheduler` |
| 2 | `no-circular, scheduler, workgroup/launch` | `workgroup/launch → task → scheduler` |
| 3 | `no-circular, executor, task` | `task → scheduler → executor` |
| 4 | `no-circular, executor, workgroup/launch` | 经 executor 闭合 |
| 5 | `no-circular, agentLaunch, task` | `task → scheduler → executor → agentLaunch` |
| 6 | `no-circular, gc, expandService` | `expandService → task → gc` |

**C-6**（`task → scheduler → outcome → agentLaunch → task`）无独立账目，与 C-5 共享
同一 `(from,to)`；断 C-5 只换 witness、**不换 key**。A1 断则 C-1..C-6 全塌；
**C-7（`task → gc → expandService → task`）不经 A1**，靠 E3 + G5 的 E1 断。

### 1.2 G6 四族（用户决策：全 backend 归零）

| 族 | 成员 | 回边符号与锚 | 断法 | 现有账目 |
| --- | --- | --- | --- | --- |
| agent | `agent` / `agentDeps` / `agentResourceIntegrity` | `validateDependsOn ↔ getAgentById`、`assertAgentResourceIntegrity ↔ listAgents`（`services/agent.ts:33,51,174,212,386,423`、`agentDeps.ts:36,114,169,182`、`agentResourceIntegrity.ts:133-135`） | 注入 agent loader / list loader，**不迁 owner** | `agent→agentDeps`、`agent→agentResourceIntegrity` |
| workflow | `workflow` / `workflow.validator` | `validateWorkflowById ↔ getWorkflow`（`services/workflow.ts:82,808-812`、`workflow.validator.ts:104,430-444`） | 注入 workflow loader | `workflow→workflow.validator` |
| **git（5 成员）** | `gitRepoCache` / `util/git` / `gitSubmodule` / `gitVersion` / `repoGroup` | `gitRepoCache.ts:43/49/50/52 →` 四者；**`util/git.ts:1181-1182,2744-2745` 动态 `import('@/services/gitSubmodule'\|'@/services/gitRepoCache')`（RC-4 分层倒置）**；`gitVersion.ts:9 → util/git`；`gitSubmodule.ts:14 → util/git`；`repoGroup.ts:27 → gitRepoCache` | 直接对边（repoGroup↔cache）可 DI；**分层倒置须把 `resolveSubmoduleParams`/`syncSubmodules` 参数化注入 util 层**，util 不得反向 import services | 五条 git 族账 |
| **MCP（3 成员）** | `mcp/dispatch` / `server` / `mcp/server` | `mcp/dispatch.ts:28 → @/server`；`server.ts:16 → @/mcp/server`；`mcp/server.ts:24 → @/mcp/dispatch`（另 `:29` type-only 取 `AppDeps`） | 把路由注册表下沉成不依赖 `server.ts` 的独立模块 | `mcp/dispatch→server`（`removeWhen` 写的是 **RFC-247 收尾**——见 proposal DEV-5，实现前必须协调） |

`gitRepoCache.ts:78,97` 的两个队列是 cache owner 的私有可变状态，**继续由 cache 持有**，
不随断环搬动。

## 2. 四件合同（G1，逐字采用 RFC-294 `be31dd62:design.md` §5.3）

```ts
// —— 以下四个 interface 的形状由 RFC-294 固定，本 RFC 不自创 ——
interface OwnershipToken {                    // P0-D 提供，brand 化
  readonly taskId: string; readonly ownerId: string
  readonly epoch: number;  readonly leaseUntil: number
}
interface TaskOwnershipPort {                 // ← P0-D 实现；本 RFC 只做 consumer cutover
  claim(taskId, owner, expectation): Promise<OwnershipToken>
  heartbeat(token): Promise<OwnershipToken>
  assertCurrent(scope: TransactionScope, token): void
  release(token): Promise<OwnershipReleaseReceipt>
}
interface TaskRuntimeRegistry {               // 纯 process-local
  attach(token: OwnershipToken, handle: ActiveTaskHandle): void
  get(taskId): { token: OwnershipToken; handle: ActiveTaskHandle } | null
  detach(token: OwnershipToken): void
  abortAll(reason: TaskAbortReason): string[]      // reason 非可选
}
interface TaskDriverSupervisor {              // 停机语义独立于 registry
  requestStop(token: OwnershipToken, reason: TaskAbortReason): Promise<StopRequestedReceipt>
  awaitStopped(taskId: string, epoch: number): Promise<TaskStoppedReceipt>
}
```

**与 HEAD 既有面的映射（迁移前兼容面，不是目标合同）**：

| HEAD 现状（`6e8c4f9f:packages/backend/src/`） | 性质 | 退役 |
| --- | --- | --- |
| `modules/task-execution/ports/taskDriverSupervisor.ts:18-27`：`tryAttach/requestStop/awaitStopped` 三个**异步**方法 | 迁移前兼容 port | T2b 后由上表两份接口取代 |
| `modules/task-execution/infrastructure/inMemoryTaskDriverSupervisor.ts:22-85`：`tryAttach`(**同步** boolean)、`requestStop`(**同步** ticket)、`release`(精确 owner 判定在 `:61`)、`has`、`abortAll`、`controllerOf`、`deleteIfOwned`、`clearForTesting` | adapter 能力（**不是 port 方法**） | 保留实现、改按 token 定位；`clearForTesting` 归测试 factory |
| `services/task.ts:245-267` DB 状态 + source-fence admission（在 `withTaskReviewMutationLock` 内） | **application**：`admitAndAttach` use case | 保留在 application，禁止下沉 infrastructure |
| `services/task.ts:272-287` unreaped 判定 + 精确 release + prune settlement | **application** settlement | 同上 |
| `services/task.ts:4491` 同步准备失败路径的**直接 release** | application（承重，见 proposal §4） | T2b 必须显式登记「失败可重试、只 release、不 prune」语义 |

> **为什么必须带 token**：B 路实测——`tryAttach(old) → release(old) → tryAttach(next)
> → requestStop(taskId)` 会 abort 掉 **next**。taskId-only 的停机接口无法表达
> 「停 epoch 7 而不是 epoch 8」，P0-D 的「每 task 同时可写 epoch ≤ 1」就无法由该合同
> 实现。

### 2.1 剩余 DTO（第三轮门 F3：不能只给类型名）

```ts
// transitional publisher（DEV-4：W2 只定义 port，W3 再切 committed event/outbox）
type TaskStatusChanged = Readonly<{
  taskId: string
  status: TaskStatus
  errorSummary: string | null
  terminal: boolean            // done|failed|canceled|interrupted
}>
interface TaskStatusPublisher { publish(e: TaskStatusChanged): void }
// 映射：tasks-list 频道 'task.status'；task 频道 'task.status'（errorSummary 非 null 才带）；
// terminal 时追发 task 频道 'task.done'。载荷源＝现 emitTaskStatus（6e8c4f9f:.../task.ts:4979）。
// ⚠️ 后置屏障必须原样保留：task.ts:3745 等 reap/rollback、:4930 等 node-run mint、
//    workgroup/dwActions.ts:217 等 DW state——不得改成 repository commit 即时发射。

interface SchedulerDriverPort {
  kick(req: KickRequest): Promise<void>
  cancel(req: { taskId: string; cascadeFromParent?: boolean }): Promise<void>
  resume(req: { taskId: string; deps: ResumeDriverDeps }): Promise<void>
}
// KickRequest 逐字段映射四个现有构造点（T1 产出保真表），不吃 god-type RunTaskOptions。
// ResumeDriverDeps 复用结构化 InheritableRunConfig（B 路实测：StartTaskDeps 45 字段里
// resume 真正读的是 17 个 Inheritable 字段 + killStaleRunProcessTree / awaitScheduler /
// commitPush / mergeAgent 共 21 项；db 由 module context 提供，triggerContext /
// actorUserId 在 resume 中未读、不进 DTO）。
```

## 3. 装配、生命周期与注入（G1 下半）

- **不再有** `registerSchedulerDriver` / 全局 `driver` / 「未注册即响亮 throw」。
  理由：① 初稿类比的 `services/orphanReconcile.ts:90-127` 只是每次调用显式传入的
  可选依赖（`ReconcileDeps.taskHasDriver?` + `?? isTaskActive`），不是模块级 locator；
  ② 运行期 throw 会被 `services/scheduler.ts:3487` / `:3528` 的裸 catch 吞掉；
  ③ 19 个直调 `startTask(` 的测试里 17 个不走 `createApp`。
- **生命周期定死**（第三轮门 B 路 P1）：
  - production **每 daemon 一个** `TaskExecutionModule`；`createApp` **只借用、不拥有**
    （`server.ts:163-165` 是可重复调用的普通 factory，不能承担 module 所有权）。
  - module 提供 `dispose()` / `awaitIdle()`。
  - **process-local registry 不闭包在 `DbClient` 上**；DB 由每个 application command
    显式提供——否则 `rfc165-scratch-space.test.ts:275-317` 那种「只对单次调用注入
    `Proxy<DbClient>`」的故障注入会被绕过，测试静默失去预言力。
  - 测试统一 `createTaskExecutionTestModule({ driver: 'poison' | 'real' })`；
    `rfc301-task-launch-origin-inheritance.test.ts` 需要 poison driver 来断言
    「绝不被调用」。
  - 装配窗口：`cli/start.ts:657-670` 建 app → `:675` listen → `:955-964` schedule
    ticker → `:972-989` auto-resume；**fail-fast 必须早于 listen**。
- **T2a 的 canary**（防零预言力）：装配锁除「存在/顺序/重复」外，必须断言 HTTP
  launch、background launch、scheduler child recovery **观测到同一个 module id**，
  并对 poison method 做变异实证。

### 3.1 四个 kick 点

| # | 锚（`6e8c4f9f:.../task.ts`） | 场景 |
| --- | --- | --- |
| 1 | `:2946` | startTask / deferred continuation |
| 2 | `:3757` | resumeTask |
| 3 | `:4308` | **RFC-287 AC-11 retryRepoPreparation**（配套 attach/release 在 `:4263-4267`/`:4491`） |
| 4 | `:4936` | retryNode |

每点附 `KickRequest` 保真表；延续 `rfc103-launch-config-passthrough.test.ts:172-180`
的四次计数锁；新增负扫描「`task.ts` 除注释外不得出现 `runTask(`」（AST 判定，见 §11）。

### 3.2 双 registry 中间态的堵法（第三轮门 B 路 P0）

T2b 一旦把 registry 迁进 module 实例，而 B2/B3/B4 仍走动态 import 调 module-level
`cancelTask/resumeTask/isTaskActive`（它们从 `services/task.ts:235` 的进程单例取状态），
就会出现**两个 registry**：DB 被写 canceled，而真 driver 在另一个 registry 里继续跑
（`services/task.ts:3353-3392` 的 no-driver fallback 正是这条路径）。

⇒ **先加一刀（T2b-0）**把同一个 `TaskExecutionContext` 线程化进
`StartTaskDeps → KickRequest → SchedulerState → child cancel/resume/isActive`，
此时仍适配旧 registry；下一刀才替换 backing instance。**禁止**用 global locator
兜这个中间态。

## 4. workspace / materialization（G2，终局迁位）

初稿的行区间 `379-1741` 不是合法切片（两端都在注释里），改为符号级：

- **迁 source-control（终局 owner，DEV-3）**：`materializeWorktree`、repo resolution
  （`resolveRepoSourceSingle` 等）、cleanup ledger（`createMaterializedSpaceCleanup` /
  `cleanupMaterializedSpaceLease` / `cleanupMaterializedSpace` /
  `withWorkspaceCleanupReport`）、group/single/scratch materializer
  （`materializeGroupSpace` / `materializeSpace` / `loadFrozenSpaceLayout` /
  `ensureExplicitDirectoryNodes`）。新建**窄 `MaterializeDeps`**，不携整个
  `StartTaskDeps`。
- **留 task-execution**：`normalizeStartTaskRepos`、`selectResumeRollbackTargets`、
  `selectSyncRollbackTargets`、`runtimeConfigOpts`、`workflowLaunchVersionMismatch` /
  `workflowLaunchHookEvent`。
- **留 application 编排**：`ensureCachedRepoIdentity`、同步 `materializeSpace` 调用、
  `runDeferredRepoPreparation` 及其延后准备再次调用——经 source-control
  materialization port 调用，不随原语迁走。
- `minimalNodePaths`：提成无 IO 的 workspace projection，供 query 与 materialization
  共用（现被区间外的 `getTask` 使用）。

## 5. task read model 三分（G3）

- 窄义 `getTask`（`6e8c4f9f:.../task.ts:5005` 起）与 `getTaskNodeRuns`：纯 DB + DTO +
  纯投影 ⇒ `task-execution/application/queries`；`expandService.ts:12` 改锚（E3 断，
  销第 6 条账）。
- archived events / stdout（FS 读经 `readArchivedEvents` 等）：同属 application
  queries，但 **FS 访问走 required port**，不在 query 里直接碰文件系统。
- `getTaskDiff`（`:5613`）：**拆双 owner**——task 侧保留 orchestration（先加载 task、
  保持 task-specific 409/410 错误顺序），Git/worktree 部分下沉 source-control /
  workspace-insight participant。

每个 query 必须列 DTO、错误码与顺序、consumer；**禁止用「族」「等」作迁移范围**。

## 6. scheduler 归位 inventory（G4）

- **依赖闭包**（第三轮门 B 路 P0：清单不是闭包会 typecheck 红或造新环）：
  - `deriveFrontier`（`:2328`）依赖 scheduler 私有 `SETTLES_WITHOUT_ROW_KINDS` /
    `isLiveStatus`（`:2295-2305`，调用于 `:2399-2403`）；
  - `createOrRebuildWrapperIso` 依赖 `parseIsoJsonMap` / `parseIsoSubmodules`
    （`:2672-2725`，调用于 `:8833/:8853`）——需为 wrapper-iso 定义不依赖
    `SchedulerState` 的 owner DTO。
  - 这四个私有符号**必须一并纳入迁移**，否则「纯符号归位 + 不留 re-export + AC-1」
    三者不可兼得。
- **scheduler 内部调用数**（AST 实测）：`buildContainerMap` **0**（可干净搬）、
  `deriveFrontier` 1、`isFresherNodeRun` 2、`decideEnvelopeFollowup` 1、
  `pickInheritableRunConfig` 1、`shouldRetryNodeFailure` 3、`resolveUpstreamInputs` 6、
  `composePriorOutputBlock` 2、`freshestPriorRunWithOutput` 2、`fanoutInnerAgentKey` 2、
  `createOrRebuildWrapperIso` 2 —— 合计 22 个内部调用点。
- **import consumer**：九组消费归属合计 28，**去重后 27 个测试文件**
  （`rfc144-stale-replay-regression.test.ts` 同属 frontier 与 wrapper 两组）；
  生产消费者 1 个：`services/lifecycleRepair/options-S1.ts:24`（调用于 `:69`）。
- **source-text consumer（import inventory 覆盖不到，必须同步改断言目标）**：
  `rerun-prior-output-source-guards.test.ts:21-29`（强制函数仍 export 于 scheduler）、
  `scheduler-wrapper-fanout-routing.test.ts:55-61`（直接切 scheduler 里的
  `buildContainerMap`）、`rfc096-pick-freshest.test.ts:231-235`（强制 re-export 与
  freshness 同一函数）、`rfc287-t9-exemptions-and-extinction.test.ts:122-127`
  （从 scheduler 函数体取源码）。
- **新增源锁**：任何 T6 owner **不得值 import `scheduler.ts`**。

## 7. C2 frozen 面

现有 facade 的 workgroup arm 不能复用：node invoker 只允许 workflow
（`execution/executor.ts:61-75` 抛 `execution-invoker-unsupported`）；公开
`StartExecutionRequest` 的 workgroup arm 只有普通 `StartWorkgroupTask`
（`execution/types.ts:58-67`），executor 分支调 **live** `startWorkgroupTask`
（`:104-110`）；而 frozen face 不得重读 workgroup resource / OCC fence，且仍要执行
roster/resource gates（`workgroup/launch.ts:330-338,341-402`）。

⇒ 新增**内部** participant（`LaunchFrozenWorkgroupChild`）：frozen group payload、
parent task/node-run/invocation depth、继承的 materialized space、owner-active
preflight、collaborator 并集、gates ④-⑦ 及原错误码与顺序；**不可由 HTTP / public
operation 构造**。AC-7 要求每项一条断言。

## 8. gc 旁支（G5）

`materializingSpaces` 定义 `services/gc.ts:60`；GC 读 `:501` / `:551`；task 写删
`services/task.ts:1336 / 1788 / 1836 / 2177`。`finishClaimedWebhookWorkspacePrune`
消费于 `services/task.ts:287`（driver release）与 `:356`（无-driver 终态取消）。
**两个符号一并迁走**（DEV-3 终局 owner），`task→gc` 值边消失；保留 lease 的既有竞态
保证：**mkdir 前登记、落行/清理后释放**。

## 9. 账本策略

- 违规身份是 `(rule, from, to)` 三元组（`scripts/depcheck.ts:316-317`）；`stale` 与
  `unknown` **都是硬失败**（`:398` / `:402`）。
- 每刀提交的原子顺序：改源码 → 跑 `bun run depcheck` 读**实际** unknown/stale →
  同一提交内删 stale、**只对实际出现的 exact tuple** 追加临时条目（`removeWhen:
  'RFC-288 T<n>…'`，满足 `depcheck-gate.test.ts:200-224` 格式棘轮）→ 复跑归零 → 提交。
- **禁止预测性预登记**（预登记未出现的 tuple 会立刻判 stale）。
- 各刀预期：T0 无账本变化；**T2d 同一提交内删 A1 + 前 5 条账**（否则 depcheck stale
  红 / lint unused import 红二选一，`--max-warnings 0`）；T5 删第 6 条；G6 各族刀各删
  本族账。
- fixture：`depcheck-gate.test.ts:61` 的本地 `CYCLE`/`KNOWN_CYCLE` 并不断言样例真在
  生产账本中 ⇒ 改名 `SYNTHETIC_CYCLE`（或改为从 `KNOWN_VIOLATIONS` 取样并断言存在）；
  同步处理 `:63-64` / `:78` / `:85` / `:143-152` / `:301`。
- **机器账本（RFC-294 W0 强制，第三轮门 C 路 P1）**：新增/迁移的每个 symbol 要写
  `module-symbol-owners`、`public-surfaces`、cross-context edge、composition entry、
  facade/exception 条目（含 `removeAfterWave` / `expiresOn` / `mutationTest`）与 API
  snapshot；每刀同步 stale/unknown、type-taint、forge、consumer-method 与规则变异门。

## 10. 测试策略

**拓扑 oracle ≠ 行为 oracle**。每刀必须保持下列既有锁（T1 先跑成基线并记录
「文件 + 用例 + 期望」）：

| 行为面 | 锁 |
| --- | --- |
| generation / stale owner / stop receipt / unreaped | `rfc303-runtime-ownership.test.ts:27-71` |
| abort reason 与 shutdown 终态 | `rfc202-source-locks.test.ts:16-23,35-40` |
| 四 kick 与配置透传 | `rfc103-launch-config-passthrough.test.ts:172-180` |
| WS 频道 / 顺序 / terminal cadence | `ws-broadcast-golden.test.ts:1-27,76-114` |
| 级联取消 + 重启后领养同一 child | `rfc243-call-workflow.test.ts:406,615` |
| frozen workgroup 全链 | `rfc243-call-workgroup.test.ts:129` |
| 准备前注册 / orphan 豁免 / 重试点火 / 真异步 | `rfc287-t13-deferred-prep.test.ts`（**入口行已漂，T1 现扫**） |
| 物化成功/失败/清理/竞态/CAS | `rfc165-scratch-space.test.ts`、`rfc248-materialize-group.test.ts`、`rfc199-start-task-workflow-race.test.ts` |

**新增锁**：

- **同步准备失败 → handle 不泄漏**：驱动
  `startTask(unreachableRepo, { deferRepoPreparation: true, awaitScheduler: true,
  gitBaselineSyncWindowMs: 0 })`，断言随后的 `__repo_prep__` 重试**不**返回
  `task-still-running`（对应 proposal §4 第六项）。
- **装配锁**：见 §3（含 canary 与 poison 变异）。
- **双 registry 负锁**：同一 DB 两个 app：A 启动、B 取消 ⇒ 必须停到同一 driver。
- **源锁 AST 化 + 变异实证**：依赖/调用守卫改 AST exact symbol/import（文本正则
  防漂移是无底洞）；每条守卫在射程内做变异并证明**必红**。
- **初始化锁**（C1/C2 各自那刀）：四种 import 顺序 smoke + 真实 facade 调用 +
  `bun run build:binary` + 单二进制启动 smoke。
- **G6 每族**：baseline oracle → additive port/参数化 → 单 consumer cutover → 负扫描；
  git 族另需 submodule/repo-group/cache 语义 oracle，MCP 族另需 HTTP/MCP parity 与
  route registry oracle。
- **终局棘轮**：Tarjan 投影断言 backend 零值级 SCC，**复用 depcruise 原始 `modules`
  图源**（`scripts/depcheck.ts:488` 取图处），扩 `CruiseDependency`
  （`:294`）携带 `dependencyTypes`；不另写第二套 parser。

**每刀**：pin worktree `bun run gate:local` 全绿 + exact-SHA CI；**T4/T9 另跑**
`RUN_GIT_NETWORK=1`（`gate:local` 对 `skipIf(!RUN_GIT_NETWORK)` 门后的套件一个都不跑，
清单用 `grep -rln "skipIf(!RUN_GIT_NETWORK" packages/backend/tests/` 现扫）。
**T6 改锚纪律**：除 import specifier 外，断言体/期望值/snapshot 一律不得改；任何断言
变化逐条说明并单独评审（防「顺手改绿」）。

## 11. 提交纪律（DEV-1 修订形态）

「不留 facade」与「源码/改锚分提交」不可兼得——无 facade 时至少一个 commit 必然
typecheck 红。⇒ **源码移动 + 全部生产/测试 consumer 改锚必须在同一个原子 commit**；
缓解措施为 repo-wide exact consumer 文件窗口 + 每刀前 `git pull --rebase` +
pin worktree `gate:local` + exact-SHA CI。共享 `main` 上**不得**出现不可构建的 SHA。

## 12. 偏离台账

见 proposal §5 的 DEV-1..DEV-6（不留 facade 原子提交形态 / G6 四族早于 W4-W5 /
终局迁位提前 / publisher 只落 transitional port / MCP 撞 RFC-247 收尾需协调 /
`ports/` 落位条件化）。新增偏离必须同样入台账并再次呈批。

## 13. 锚漂说明

本文锚全部对准 `6e8c4f9f`。初稿（锚 `da706b19`）与第二稿（锚 `01d2160e`）的对照不再
保留在正文——两次基线之间 `task.ts` / `scheduler.ts` 经 22 / 15 个提交、净变化近 5000
行，逐锚复核只对**开工当刻**的 SHA 有意义。T1 的第一子任务即产出「开工 SHA → 全部
承重锚」的冻结 manifest，AC-3 以该 manifest 为准。
