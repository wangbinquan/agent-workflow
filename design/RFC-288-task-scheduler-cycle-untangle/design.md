# RFC-288 — 技术设计（design，2026-08-14 设计门后重写）

> 锚基线：**HEAD `01d2160e`**。初稿锚 `da706b19` 已漂 160 个提交（RFC-287
> T1-T14 全部落地；`scheduler.ts` 10115 行、`task.ts` 5880 行），逐条对照见 §12。
> 实现期每批第一子任务仍是**逐锚复核**——本文锚同样会漂。

## 1. 环地图（HEAD 实测）

**值级 SCC = 8 成员**：`task.ts` / `scheduler.ts` / `execution/executor.ts` /
`execution/outcome.ts` / `agentLaunch.ts` / `workgroup/launch.ts` / `gc.ts` /
`structuralDiff/callGraph/expandService.ts`。含 type 边为 **10**（`launchMultipart.ts`
与 `execution/types.ts` 仅以 `import type` 挂边，被 `.dependency-cruiser.cjs:137`
的 `viaOnly.dependencyTypesNot: ['type-only']` 豁免）。**风险登记**：任何人把这
两条改成值 import ⇒ SCC=10 + 门禁新红。

全边表（HEAD 实锚）：

| 边 | 锚 | 说明 |
| --- | --- | --- |
| A1 `task → scheduler` | `task.ts:153` | **目标 8-SCC 内唯一闭环上行边**（不是全仓唯一 importer，见 §6 的 `buildContainerMap`） |
| B1 `scheduler → task`（静态） | `scheduler.ts:205` | `emitTaskStatus` / `getTask`；消费仅 `:9348-9350` 两行，全环最薄边 |
| B2/B3/B4（动态） | `:3485` / `:3526` / `:3547` | `cancelTask` / `resumeTask` / `isTaskActive` |
| C1（动态） | `:3982` | `startExecution` |
| C2（动态） | `:4181` | `startWorkgroupTaskFromFrozen`——**facade 旁路**（A3 点名） |
| C3（静态） | `:258` | `getExecutionOutcome`，方向正确 |
| `executor → task/agentLaunch/workgroup/outcome` | `execution/executor.ts:21/22/23/26` | 启动臂，方向正确 |
| `outcome → agentLaunch` | `execution/outcome.ts:25` | 含 D7 单常量 `AGENT_HOST_AGENT_NODE_ID`（定义 `agentLaunch.ts:60`，消费 `outcome.ts:25,160`） |
| `agentLaunch → task` | `agentLaunch.ts:34-39` | |
| `workgroup/launch → task` | `workgroup/launch.ts:45` | |
| E1 `task → gc` | `task.ts:100` | **双符号**：`materializingSpaces` + `finishClaimedWebhookWorkspacePrune` |
| E2 `gc → expandService` | `gc.ts:36` | 方向正确，保留 |
| E3 `expandService → task` | `expandService.ts:12` | `getTask` |

RFC-287 新增的 `schedulerAssembly.ts` **未入环**（`:16` 明确不 import scheduler）。
除上表外，未发现 scheduler / executor / outcome / gc 指向 task 的其它值级或动态边。

### 1.1 七环 → 六条账的映射（替代初稿引用的、并不存在的「测绘 §2.3」）

| # | 账目 `(rule, from, to)` | 当前 depcruise witness |
| --- | --- | --- |
| 1 | `no-circular, scheduler.ts, task.ts` | `task → scheduler` |
| 2 | `no-circular, scheduler.ts, workgroup/launch.ts` | `workgroup/launch → task → scheduler` |
| 3 | `no-circular, execution/executor.ts, task.ts` | `task → scheduler → executor` |
| 4 | `no-circular, execution/executor.ts, workgroup/launch.ts` | `workgroup/launch → task → scheduler → executor` |
| 5 | `no-circular, agentLaunch.ts, task.ts` | `task → scheduler → executor → agentLaunch` |
| 6 | `no-circular, gc.ts, expandService.ts` | `expandService → task → gc` |

**C-6**（`task → scheduler → outcome → agentLaunch → task`）没有独立账目，但它与
C-5 共享**同一** `(from,to)` = 第 5 条；断 C-5 后 depcruise 只会换 witness，
**不会**改 key（初稿的「身份漂移双红」推理据此作废，见 §9）。A1 断开后
C-1..C-6 必然全塌（从 task 回到执行支的唯一出边就是 A1）；**C-7
（`task → gc → expandService → task`）不经 A1**，必须靠 E3（+ G5 的 E1）断开。

### 1.2 G6 外扩的另外三族值级 SCC（用户 2026-08-14 决策纳入）

| 族 | 成员 | 现有账目 |
| --- | --- | --- |
| agent 三环 | `agent.ts` / `agentDeps.ts` / `agentResourceIntegrity.ts` | `agent→agentDeps`、`agent→agentResourceIntegrity` |
| git 二环 | `gitRepoCache.ts` / `repoGroup.ts` | `gitRepoCache→repoGroup`（git 族共五条，其余为 `util/git` 分层倒置，**不在本 RFC 范围**） |
| workflow 二环 | `workflow.ts` / `workflow.validator.ts` | `workflow→workflow.validator` |

各自独立成刀、可单独回退；只动 import 拓扑，**不动 owner 归属**（owner 迁位仍
归 RFC-294 W4/W5）。

## 2. 四件合同（G1，替代初稿的单叶子）

初稿的 `services/taskDriver.ts`（activeTasks + emitTaskStatus + kickScheduler +
全局 `registerSchedulerDriver`）**作废**。按 RFC-294 §5.2 拆为：

```ts
// ① modules/task-execution/ports/taskRuntimeRegistry.ts —— 本进程 active handle
//    直接复用 HEAD 既有合同，不重新发明：
//    modules/task-execution/ports/taskDriverSupervisor.ts 的
//    TaskDriverSupervisor / TaskDriverStopTicket / TaskDriverStopResult
export interface TaskRuntimeRegistry {
  tryAttach(taskId, controller): Promise<'attached' | 'rejected-status-or-source-fence'>
  requestStop(taskId, cause: TaskStopCause): Promise<TaskDriverStopTicket | 'no-active-owner'>
  awaitStopped(ticket): Promise<TaskDriverStopResult>          // released | unreaped
  release(taskId, controller /* 精确 owner */, result): boolean
  abortAll(cause?: unknown): string[]                          // reason 保真，返回被中止的 id
  has(taskId): boolean
}

// ② modules/task-execution/ports/taskOwnership.ts —— lease / epoch / fencing
//    实现来自 P0-D；本 RFC 只声明消费面，不建第二套 lease/schema。

// ③ modules/task-execution/ports/taskStatusPublisher.ts
export interface TaskStatusPublisher { publish(committed: TaskStatusChanged): void }
//    唯一机械载荷 = 现 task.ts:4875-4899 的 emitTaskStatus（只依赖两个
//    broadcaster + shared Task 类型，实测可无损搬运）。

// ④ modules/task-execution/ports/schedulerDriver.ts —— 窄端口，实例注入
export interface SchedulerDriverPort {
  kick(taskId, opts: RunTaskOptions): Promise<void>
  cancel(taskId, opts: { cascadeFromParent?: boolean }): Promise<void>
  resume(taskId, deps: ResumeDriverDeps): Promise<void>   // 独立窄 DTO，不用 StartTaskDeps
}
```

**为什么 `resume` 不复用 `StartTaskDeps`**：它是横跨 `task.ts:359-621` 的 20+ 字段
application API，RFC-294 `design.md` **§5.2 Task application commands** 已要求
淘汰（同上：按小节号引用，RFC-294 行锚会随其重写而烂）；`import type` 虽被
type-only 豁免放行，但会让「窄端口」名存实亡。

**admission / settlement 不下沉**：`tryAttach` 的状态 + source-fence 判定
（`task.ts:239-267`）与 release 时的 unreaped 判定 + workspace prune 完成
（`:269-287`）依赖 DB/GC，**留在 application use case**，只有纯 process-local 的
handle 表进 infrastructure。初稿把它们一起说成「零 service 依赖叶子」是错的。

## 3. 装配与 bootstrap（废弃全局 register seam）

- **不再有** `registerSchedulerDriver` / 全局 `driver` / 「未注册即响亮 throw」。
  理由（设计门实测）：① 初稿类比的 `orphanReconcile.ts:90-127` 只是**每次调用
  显式传入的可选依赖**（`ReconcileDeps.taskHasDriver?` + `?? isTaskActive`），
  不是模块级 locator；② 运行期 throw 会被 `scheduler.ts:3487` 与 `:3528` 的裸
  `catch` 吞掉——取消会「看起来成功」而 child driver 继续跑、resume 会把可恢复
  child 误判 `child-interrupted` 进而 fail parent；③ 19 个直调 `startTask(` 的
  测试里 **17 个不走 `createApp`**，全局注册面在 `--isolate` 下会成片红，在手敲
  共享进程下又变成文件顺序依赖（前一个文件的注册掩盖后一个的遗漏）。
- **改为**：最小 `TaskExecutionModule` instance 在**当前** composition root 装配
  （`cli/start.ts:657-670` 建 app → `:675` listen → `:955-964` schedule ticker →
  `:972-989` auto-resume——这个窗口天然安全，问题只是初稿没把它变成显式合同），
  端口随实例注入 route / executor / scheduler；**未装配即 bootstrap fail-fast**，
  且 fail-fast 必须发生在 `Bun.serve`、ticker、auto-resume 之前。测试显式构造
  实例（`modules/task-execution/composition/sourceTermination.ts` 是既有先例）。

### 3.1 四个 kick 点迁移表（初稿写三点，漏第三个）

| # | 锚 | 场景 | 迁移后 |
| --- | --- | --- | --- |
| 1 | `task.ts:2919` | startTask / deferred continuation | `SchedulerDriverPort.kick` |
| 2 | `task.ts:3701` | resumeTask | 同上 |
| 3 | `task.ts:4252` | **RFC-287 AC-11 retryRepoPreparation**（配套 attach/release 在 `:4207`） | 同上 |
| 4 | `task.ts:4832` | retryNode | 同上 |

每点附 `RunTaskOptions` 保真表；延续
`rfc103-launch-config-passthrough.test.ts:172-180` 的计数锁；新增负扫描
「`task.ts` 中除注释外不得出现 `runTask(`」；新增 kick 站点必须登记 owner、
配置透传与 attach/release。

## 4. workspace / materialization 符号清单（G2，替代行区间）

初稿的 `task.ts:379-1741` **不是合法切片**：`:379` 落在 `StartTaskDeps` 的字段
注释里，`:1741` 落在 `materializeSpace` 的参数注释里（该函数到 `:2045` 才结束）。
改为按符号迁移：

- **迁 source-control / execution workspace**：`materializeWorktree`、repo
  resolution（`resolveRepoSourceSingle` 等）、cleanup ledger
  （`createMaterializedSpaceCleanup` / `cleanupMaterializedSpaceLease` /
  `cleanupMaterializedSpace` / `withWorkspaceCleanupReport`）、
  group/single/scratch materializer（`materializeGroupSpace` / `materializeSpace`
  / `loadFrozenSpaceLayout` / `ensureExplicitDirectoryNodes`）。新建**窄
  `MaterializeDeps`**，不携整个 `StartTaskDeps`。
- **留 task-execution**：`normalizeStartTaskRepos`、`selectResumeRollbackTargets`
  （`:981-1014`）、`selectSyncRollbackTargets`（`:1016-1050`）、
  `runtimeConfigOpts`（`:1052-1078`）、`workflowLaunchVersionMismatch` /
  `workflowLaunchHookEvent`——它们在初稿区间内但不属物化域。
- **留 application 编排**：RFC-287 的 `ensureCachedRepoIdentity`（`:2453`）、
  同步 `materializeSpace`（`:2477`）、`runDeferredRepoPreparation`（`:4280`）、
  延后准备再次调用 `materializeSpace`（`:4338`）——经 source-control
  materialization port 调用，**不随物化原语迁走**。
- **`minimalNodePaths`**（定义 `:1389-1399`，被区间外的 `getTask` 在
  `:4925-4930` 使用）：提成无 IO 的 workspace projection，供 query 与
  materialization 共用。

## 5. task read model 三分（G3）

- **窄义 `getTask`**（`task.ts:4901-4941`）：纯 DB 查询 + DTO 映射 + 纯投影，
  实测无编排 / 物化 / 写路径调用 ⇒ 迁 `task-execution/application/queries`。
  `expandService.ts:12` 改 import 它（E3 断，第 6 条账销）。
- **`getTaskNodeRuns`**（`:5177`）：同上，task view/list/node-run projection。
- **archived events / stdout**（`:5372-5442` 真实 FS 读在 `:5398`；
  `:5449-5478` FS 读在 `:5470`）：归 task-execution 的 log/artifact query，
  **经 port 读 FS**，不塞进 application query。
- **`getTaskDiff`**（`:5509-5615`，调 `isGitWorkTree` / `worktreeDiff` /
  `gitDiffSnapshot` 于 `:5533/:5542/:5590`）：归 source-control /
  workspace-insight query。

每个 query 必须列 DTO、错误码与顺序、consumer；**禁止用「族」「等」作为迁移
范围**。

## 6. scheduler 符号归位 inventory（G4，收缩前必须先做）

现状：除白名单外 `scheduler.ts` 仍导出 config（`:407/:429/:436`）、freshness
转发（`:1497`）、envelope/retry（`:1516/:1549/:1578/:1594`）、frontier
（`:2251/:2328`）、fanout/iso/query helpers（`:7072/:8749/:9511/:9744/:9787`）、
`buildContainerMap`（`:10113`）。

- **生产消费者**：`lifecycleRepair/options-S1.ts:24` import `buildContainerMap`
  并在 `:69` 调用 ⇒ 直接收缩 export 会 typecheck 红。
- **测试消费者（AST 盘点 28 个文件）**：

| 符号 | 消费方（文件数） |
| --- | --- |
| `deriveFrontier` / `Frontier` | 12（derive-frontier、rfc092×2、rfc095、rfc120×2、rfc130、rfc144、scheduler-audit-s01/s12/s22 等） |
| `isFresherNodeRun` | 6（dispatch-multi-row-consistency、isfresher-noderun-baseline、lifecycle-wrapper-nested、rfc074、rfc096、scheduler-fresher-noderun-cci） |
| `PreviousAttemptShape` / `decideEnvelopeFollowup` | 3（rfc123、scheduler-envelope-followup-branch、scheduler-port-validation-followup-decide） |
| `INHERITABLE_RUN_CONFIG_KEYS` / `pickInheritableRunConfig` | 1（rfc284-t20） |
| `shouldRetryNodeFailure` | 1（rfc287-t1） |
| `resolveUpstreamInputs` | 2（resolve-upstream-inputs-picker-baseline、scheduler-audit-s05） |
| `composePriorOutputBlock` / `freshestPriorRunWithOutput` | 1（rerun-prior-output-injection） |
| `fanoutInnerAgentKey` | 1（rfc223-pr3a） |
| `createOrRebuildWrapperIso` | 1（rfc144） |

归位方向：`Frontier`/`deriveFrontier`/`buildContainerMap` → `dispatchFrontier`
（终局 owner 为 `task-execution/engine/task`）；`isFresherNodeRun` →
`freshness`；envelope/retry、prior-output、upstream-inputs、wrapper-iso、
fanout-key 各归明确 owner。零外部 consumer 的类型（`InheritableRunConfig`、
`EnvelopeFollowupDecision` 等）单独去 export，不与承重迁移混刀。**按偏离项 1，
归位刀内一次改完消费方 import，不留 re-export**；改锚提交与源码提交分离。

## 7. C2 frozen 面（AC-7）

现有 facade 的 workgroup arm 不能复用：node invoker 只允许 workflow，workgroup
会抛 `execution-invoker-unsupported`（`execution/executor.ts:61-75`）；公开
`StartExecutionRequest` 的 workgroup arm 只有普通 `StartWorkgroupTask`
（`execution/types.ts:58-67`），executor 分支调的是 **live** `startWorkgroupTask`
（`:104-110`）——而 frozen face 明确不得重读 workgroup resource / OCC fence，且仍
要执行 roster/resource gates（`workgroup/launch.ts:330-338,341-402`）。

⇒ 新增**内部** participant（如 `LaunchFrozenWorkgroupChild`），声明：frozen group
payload、parent task/node-run/invocation depth、继承的 materialized space、
owner-active preflight、collaborator 并集、gates ④-⑦ 及原错误码与顺序；
**不可由 HTTP / public operation 构造**。对拍用 `rfc243-call-workgroup.test.ts:129`
与 call-workflow shutdown/adoption 家族。

## 8. gc 旁支（G5）

`materializingSpaces` 生产读写全集：定义 `gc.ts:53-60`；GC 读
`gc.ts:483-504,551-554`；task 写/删 `task.ts:1315,1767,1815,2156`。下沉为零依赖
lease registry**可行**；但 `task.ts:100` 同一条 import 还带
`finishClaimedWebhookWorkspacePrune`（消费于 `:287` driver release 与 `:352`
无-driver 终态取消），**只搬 Map 断不了 `task→gc`**。按用户决策两个符号一并迁走
（prune 入独立 workspace-prune 模块），并覆盖上述两条调用路径 + stop-ticket
settlement 测试。保留 lease 的既有竞态保证：**mkdir 前登记、落行/清理后释放**。

## 9. 账本策略（AC-2 实现细则）

- 违规身份是 `(rule, from, to)` 三元组（`scripts/depcheck.ts:316-317`）；
  `stale`（账上有、实际无）与 `unknown`（实际有、账上无）**都是硬失败**
  （`:398` / `:402`）。
- 每刀提交的原子顺序：改源码 → 跑 `bun run depcheck` 读**实际** unknown/stale →
  同一提交内删除全部 stale、**只对实际出现的 exact tuple** 追加临时条目
  （`why` 注明中间态，`removeWhen: 'RFC-288 T<n>…'`，满足
  `depcheck-gate.test.ts:200-224` 的格式棘轮）→ 复跑 depcheck + 单测归零 → 提交。
- **禁止预测性预登记**：预登记尚未出现的 tuple 会立刻被判 stale（这正是初稿
  C-6 建议会踩的坑）。
- 各刀预期：T0（D7 下沉）不产生账本变化；断 A1 那刀删前 5 条；G3/G5 那刀删第
  6 条；G6 三刀各删本族账目。
- fixture：`depcheck-gate.test.ts:61` 的本地 `CYCLE` / `KNOWN_CYCLE` 并不断言
  样例真在生产 `KNOWN_VIOLATIONS` 中 ⇒ 改名 `SYNTHETIC_CYCLE` 只锁算法性质
  （或改为从 `KNOWN_VIOLATIONS` 取样并断言存在）。scheduler↔task 硬编码不止
  `:63-64`，还有 `:78`、`:85`、`:143-152` 与 `:301` 的注释，一并处理。

## 10. 测试策略

**拓扑 oracle ≠ 行为 oracle**：depcheck / Tarjan 只证明 import 图，不证明终止
原因、owner generation、WS cadence、四点配置透传、frozen closure 或失败恢复。
每刀必须保持下列行为锁（T1 先把它们跑成基线夹具，记录**文件 + 用例 + 期望**）：

| 行为面 | 锁 |
| --- | --- |
| generation / stale owner / stop receipt / unreaped | `rfc303-runtime-ownership.test.ts:27-71` |
| abort reason 与 shutdown 终态（interrupted 非 canceled） | `rfc202-source-locks.test.ts:16-23,35-40` |
| 四个 kick 与配置透传 | `rfc103-launch-config-passthrough.test.ts:172-180` |
| WS 频道 / 顺序 / terminal cadence | `ws-broadcast-golden.test.ts:1-27,76-114` |
| 级联取消 + 重启后领养同一 child | `rfc243-call-workflow.test.ts:406,615` |
| frozen workgroup 全链 | `rfc243-call-workgroup.test.ts:129` |
| 准备前注册 / orphan 豁免 / 重试点火 / 真异步 | `rfc287-t13-deferred-prep.test.ts:249,298,313,415,632` |
| 物化成功/失败/清理/竞态/CAS | `rfc165-scratch-space.test.ts:169-380`、`rfc248-materialize-group.test.ts:176-525`、`rfc199-start-task-workflow-race.test.ts:113-761` |
| 架构锁（含 top-level const 初始化事故记录） | `rfc217-architecture-locks.test.ts:3-10` |

新增锁：

- **装配锁**：未装配必须在 HTTP / background 启动前失败；重复装配（同实例幂等、
  异实例硬拒）；同文件多 `createApp`；`--isolate` 与 serial 两种进程模型；
  不得跨文件借到驱动。
- **源锁**：`scheduler.ts` 禁 `from '@/services/task'`（rfc257 同型，当前该型
  source-ban 在 `:22-28`）；`task.ts` 禁 `runTask(`；CALL_FACES（`:45-53`）更新对。
- **初始化锁**（C1/C2 各自那一刀）：task/scheduler/executor/workgroup 不同顺序的
  import smoke + 调用真实 facade 的最小行为锁 + `bun run build:binary` + 单二进制
  最小启动 smoke。
- **终局棘轮**：Tarjan 投影断言 backend 零值级 SCC；**复用 dependency-cruiser 的
  原始 `modules`（`scripts/depcheck.ts:488` 取图处）**，只加纯 SCC 聚合器，并把
  过窄的 `CruiseDependency` 类型（`:294`）扩到携带 `dependencyTypes`；**不另写
  第二套 import parser**。

**每刀**：pin worktree 跑 `bun run gate:local` 全绿 + exact-SHA CI；定向家族只作
快速反馈（RFC-287 T14 实测「按 RFC 编号选测试」会漏掉不含该编号的锁）。

## 11. 偏离项台账

见 proposal.md §5 的三条（不留 facade / G6 早于 W4-W5 / `ports/` 命名），均已于
2026-08-14 逐条呈用户确认。任何新增偏离必须同样入台账并再次呈批。

## 12. 锚漂对照表（初稿 → HEAD 实测）

| 初稿写的 | HEAD 实际 |
| --- | --- |
| A1 `task.ts:114` | `task.ts:153` |
| `activeTasks: Map<string, ActiveTaskHandle>` @ `task.ts:191` | 模型已变：`taskDriverRegistry = new InMemoryTaskDriverSupervisor()` @ `:235`；`ActiveTaskHandle` 不存在 |
| `abortAllActiveTasks(): void` | `abortAllActiveTasks(reason?: string): string[]` @ `:330` |
| `emitTaskStatus` @ `:3959-3980` | `:4875-4899`（同一函数体） |
| kick 三点 `:2498/:3158/:3916` | 四点 `:2919/:3701/:4252/:4832` |
| B1 `scheduler.ts:202`；消费 `:9108-9109` | `:205`；消费 `:9348-9350` |
| B2/B3/B4 `:3406/:3447/:3468` | `:3485/:3526/:3547` |
| C1 `:3903` / C2 `:4102` / C3 `:253` | `:3982` / `:4181` / `:258` |
| 物化域 `task.ts:379-1741` | 两处均落在注释中；`materializeSpace` 到 `:2045` 才结束（改符号清单，§4） |
| `getTask` 读模型 | `task.ts:4901-4941` |
| E2 `gc.ts:35` | `gc.ts:36` |
| `orphanReconcile.ts:86` seam | 契约 `:90-108`，消费 `:122-127`（且**不是**同型注入面） |
| rfc243 CALL_FACES `:45-51` | `:45-53` |
| rfc257 同型锁 `:26-33` | `:22-28` |
| 测试 import「92/88」 | scheduler 94 / task 93 |
| 「88+ 测试文件迁 helper」 | `__setActiveTaskForTesting` 族实际 3 文件 11 处引用 |
| `scheduler.ts` 9847 行 | 10115 行（`task.ts` 5880 行） |
| 「测绘 §2.3」 | 该文件只有 §1-§5；映射表已直接写进本文 §1.1 |
| 未漂 | `.dependency-cruiser.cjs:137`、`scheduledTaskRefs.ts:8-12`、`expandService.ts:12`、`depcheck.ts:317`、`depcheck-gate.test.ts:63-64` 与 `:200-238`、`.dependency-cruiser.cjs:118-122` |
