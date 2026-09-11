// RFC-359 —— **同步 SQLite 事务面**的高水位账本（只降不升）。
//
// 为什么要有这条账本：RFC-359 的目标是「以后不允许再出现两种数据库一个好一个不好的分支」。
// 而制造这种分支最省事的办法，就是在 SQLite 侧写一笔 `dbTxSync`（或它之上的 `withOwnedTaskTx`）——
// 那是 bun:sqlite 独有的**同步**事务面，PostgreSQL 上不存在，于是那条路径天然只有一个 provider
// 能走，另一个引擎要么另写一份（覆盖倒挂、行为漂移），要么干脆没有。本轮实做已经两次撞上它：
//   - W4-D23b：技能机器迁到中立事务后落不了地，因为它的提交面被 bundle apply 的**同步大事务**调用；
//   - 剩余 task-execution 对：同样卡在 `withOwnedTaskTx` 这条同步 owned-write 原语上。
// 也就是说 RFC-359 的剩余工作**不是 N 个独立的 pair 合并**，而是**一件事**：把这 129 个
// 同步调用点迁到已经存在的中立原语（`platform/persistence/databaseTransaction.ts` 的
// `databaseSessionFor` / `withTaskExecutionWrite` / `withTaskExecutionSerializable`），pair 合并会随之落地。
//
// 这条账本把「还剩多少」变成可计数、可防守的量：
//   - **只降不升**（RFC-317 T17 的高水位机制，已在 `architecture/ledger-baselines.json` 注册）：
//     新增一个同步调用点就红，逼你要么用中立原语，要么把新增写进账本并说明为什么；
//   - **逐字相等**：收敛了也要红——把账本一起改小，让每一次减少都留下一次提交记录。
// 计数方式与 `docs/dev-gotchas.md` 里那条一致：按 `dbTxSync(` 与 `withOwnedTaskTx(` 的调用点数，
// 不含它们各自的定义文件。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/** `<相对 src 的路径>: <同步事务调用点数>`，按路径字典序。只降不升。 */
export const SYNC_TRANSACTION_DEBT: readonly string[] = [
  // RFC-359 W7 销账：`clarifyRounds.ts: 1`（澄清草稿的读改写）+
  // `taskQuestions.ts: 3`（改派的三处 CAS/读改写）+
  // `collaborationWorkgroupClarify.ts: 1`（自治遣散）—— 三个文件是
  // `CollaborationRouteOperations` / `CollaborationRuntimeMechanics` 两对适配器合一时被
  // 转发到的正典实现，写事务改走 `databaseSessionFor(db).transaction(...)` + 中立的
  // `setNodeRunStatusTx`，于是 PG 侧那两份共 4016 行的原生重写整体退役。
  // RFC-359 W9 销账：`taskCollab.ts: 1 → 0` —— 任务成员全量替换
  // （`updateTaskMembersLocked`：读一批成员 → 全量 delete → insert 回去）改走
  // `databaseSessionFor(db).transaction(...)`，事务体开头 `lockAggregateRoot(tasks)`。
  // 同批删掉 RFC-326 的同步孪生 `hasActingMembershipTx`（自 W1-T2c 起生产零调用方，
  // 只有 `rfc326-tx-primitives-equivalence.test.ts` 的 AC-19 等价锁按名字钉着它）。
  // 至此 `modules/collaboration/**` 的同步事务面清零。
  // 判据在 `tests/rfc359-w9-task-members-conformance.test.ts`（两引擎各跑一遍）。
  // RFC-359 W7 销账：`sqliteReviewRepairParticipant.ts: 2` —— 它与 PG 那份合成了中立的
  // `reviewRepairParticipant.ts`，两处 `dbTxSync` 里一处改走 `databaseSessionFor(db).transaction`
  // （读改写序列），一处直接去掉（单语句 CAS 本就原子，理由写在该文件头注释）。
  //
  // RFC-359 W9 销账：`sqliteIntentApplyOperations.ts: 9 → 0` —— Intent apply 的九笔 **journal
  // 事务**（claim / recordArtifact / settleFailed / keepRetryable / 收敛的五笔）全部改走
  // `databaseSessionFor(db).transaction(...)`，CAS 判据换成中立的 `affectedRows`。
  // 没有一笔被同步参与者钉住：这九笔的事务体只碰 intent 自己的四张表（sessions / drafts /
  // draft_resolutions / apply_journal），
  // 唯一按 `DbTxSync` 定型的回调（`participantInTransaction` 的六条 legacy 提交臂）挂在
  // **大事务**上，而大事务早在 W4-D23b 就迁完了、本轮不动。级联只有一层：
  // `recordArtifact` 的契约收成 `Promise<void>`，生产 prestage 链的三处调用点补 await
  // （`legacyIntentApplyResourceParticipants.ts`，I14 record-before-act）。
  // 判据在 `tests/rfc359-w9-intent-apply-sync-transaction-cutover.test.ts`（两引擎各 13 条）。
  // RFC-359 W9 销账（resource-catalog legacy 的删除 / 改名面）：
  //   `legacy/agent.ts: 5 → 2` —— deleteAgent + renameAgent 的两笔（no-op 围栏 / 真改名）
  //     改走 `databaseSessionFor(db).transaction(...)`，改名的 CAS 判据从 `.run().changes`
  //     换成中立的 `affectedRows`（本地的 `changesOf` 随之退役）。级联只有一层：围栏门
  //     `requireAgentMutationRevision` 拆成「判据核 + 两个包装器」——判据核
  //     `assertAgentMutationAllowed` 一份（404→403→stale 的顺序是路由契约，不许抄两份），
  //     同步包装器留给还钉着的 `commitAgentUpdateInTx`，中立包装器给 delete / rename。
  //   `legacy/workflow.ts: 2 → 3` / `legacy/workgroups.ts: 2 → 3` —— **数字变大不是回退**：
  //     上面的口径修正把两个文件各 2 处 `dbTxSync<T>(…)` 从隐身状态揪了出来（真实基数 4），
  //     本轮各转掉 1 处（deleteWorkflow / deleteWorkgroup）⇒ 4 → 3。能转是因为 RFC-324 把
  //     删除面的 in-tx 门与保存面**分成了两份**：`assertPrincipalCanGovernInTx` /
  //     `assertNoScheduledReferencesInTx` / `countNonTerminalReferencingTasksInTx` 的唯一调用方
  //     就是删除那一笔，跟着改异步零级联。删除受众的授权清单走新的中立读
  //     `listResourceGrantUserIdsForTx`（`legacy/resourceRefs.ts`）——受众必须与 DELETE 同事务
  //     读走，行没了就再也读不到，WS 的 `*.deleted` 帧会投递不到那些人。
  //   `legacy/workgroup/state.ts: 1 → 0` —— 门状态 CAS 的**事务整个去掉**（不是换原语）：
  //     体内只有一条 `UPDATE … WHERE gate_status IN (…) RETURNING`，单语句两个引擎都原子，
  //     包一层事务不多给原子性、只把这条路钉死在同步面上。同步孪生 `casGateStatusTx` 一并删除
  //     （自 RFC-217 起生产零外部调用方）。
  //
  // 三个文件里**剩下的 8 笔全部钉死**，被同一条链钉着：`commitAgentCreateInTx` /
  // `commitAgentUpdateInTx` / `commitWorkgroupCreateInTx` / `commitWorkgroupSaveInTx` /
  // `commitWorkflowSaveInTx` / `insertWorkflowInTx` / `assertRefsUsableInTx` 是
  // `aggregateAdapters/legacyIntentApplyResourceParticipants.ts` 与
  // `legacyResourcePackageMutationParticipants.ts` 的参与者契约 `(tx: DbTxSync, …) => …` 的成员，
  // 改异步要连那两个适配器 + 两个 composition/services 装配点一起动（属另一刀）。
  // `legacy/importRefs.ts: 1` 同理：`resolveImportRefs` 的私有助手
  // （`assertSelectedIdsVisibleInTx` / `buildCandidateSnapshotsInTx`）与导出的
  // `assertImportRefsStableInTx` 共用，而后者正是通过 `workflow.yaml.ts` 的 `inTxGuard`
  // 被塞进上面那批钉死的 `dbTxSync` 体里的。
  // W14：create/update 两个外壳现 await 中立事务，原同步参与者仍委托同一提交体；
  // legacy/agent.ts 的实际 dbTxSync 调用 2 → 0，不把保留的同步参与者合同伪记为退役。
  // RFC-359 W31：workflow 的三处与 importRefs 的一处调用已接中立异步事务。
  // RFC-359 W32：workgroups 的三处调用已接同一中立异步事务，原提交体顺序保留。
  // RFC-359 W12：资源包 journal 合一为 resourcePackageApplyJournal.ts，settleFailed 的
  // expectedState CAS 走同一中立事务；两侧 artifact recovery 格式继续独立保留。
  // RFC-359 W10 销账：`sqliteProcessEffectObserver.ts: 1` —— 三份 SQLite 效应观察者
  // （local / process / code-host，共 903 行）自 RFC-349 起就只剩一个同样零调用方的
  // composition 再导出壳指着它们，生产路径转出的是 `application/{local,process,codeHost}
  // EffectObserver.ts`。补完双引擎对拍（`tests/rfc359-w10-effect-observer-conformance.test.ts`）
  // 后整体退役，`withOwnedTaskTx` 这一处调用点随之消失。
  // RFC-359 W10 销账：`sqliteSourceTerminationParticipant.ts: 3 → 0` —— 源终止参与者的三笔
  // 事务（重放对账 / 终态 CAS 输给别人后的补写 / 目标本就终态的直写）全部改走
  // `databaseSessionFor(db).transaction(...)`，事务体里的四个参与者各自换成两个引擎共用的
  // 那一份：`cancelOpenNodeRunsTx` → 本文件私有的 `cancelOpenNodeRunsInTx`（逐行走中立的
  // `transitionNodeRunStatusTx`，转移表 / 终态闸 / MR·PR 围栏与别处同一份）、
  // `appendTaskNodeStatusesCommittedEventTx` → `appendTaskNodeStatusesCommittedEvent`、
  // `ownership.revokeExactTx` → 新的中立事务内参与者 `revokeExactOwnerInTx`
  // （`taskOwnershipPersistence.ts`，单语句精确 owner CAS，`revokeExact` 自己也改成用它）、
  // `terminalizeTaskExecutionIntentsTx` → `terminalizeTaskExecutionIntentsInTx`。
  // 留下的同步参与者只有传给 `setTaskStatus` 的 `onTransitionTx` 回调——它挂在
  // `taskLifecycle.ts` 那笔还没转的事务上（见文件末尾那两笔的钉死理由），不是本文件的调用点。
  // 判据在 `tests/rfc359-w10-task-execution-sync-transaction-cutover.test.ts`（两引擎各跑一遍）。
  // RFC-359 W8 销账：`sqliteTaskExecutionEffect.ts` 5 → 4 —— `resolveQuiescedCodeHostMutations`
  // （唯一调用方是合一前的 SQLite 恢复流程）迁进两引擎共用的 `effectQuiescence.ts`，同时把
  // 那条钉死在 `DbTxSync` 上的 `onAppliedTx` 回调（node_run 投影）收成实现的一部分。
  // RFC-359 W8 销账：`sqliteTaskExecutionEffect.ts` 4 → 3 —— 同步 store 上的
  // `resolveQuiescedManagedProcesses`（自带一笔 `dbTxSync`）与
  // `closeRecoveredOutcomeUnknownAndRelease` 自 W1-T7b 起就没有调用方（清算只剩
  // `effectQuiescence.ts` 那一份中立实现），随 effect 账本端口合一一并删除。
  // RFC-359 W10 销账：`sqliteTaskExecutionEffect.ts` 3 → 2 —— 同步的
  // `closeOutcomeUnknownAndRelease`（一笔 `dbTxSync`）删除。它自 W1-T7b 起就没有生产调用方：
  // driver 释放序列（`taskDriverRelease.ts`）走端口落到两个引擎共用的
  // `effectQuiescence.ts#closeOutcomeUnknownAndRelease`；只剩三处测试直调，已改指中立那份。
  //
  // RFC-359 W8 销账：`sqliteTaskExecutionEffect.ts: 2 → 0` —— `prepareAndAcquire` / `settle`
  // 连同它们的 `withOwnedTaskTx` 与端口声明一并删除（文件 583 → 180 行）。它们 src 侧一直零调用方
  // （生产走 `TaskExecutionPersistence['effects']`，即中立的 `DrizzleTaskExecutionEffectPersistence`），
  // 挡着的只有测试夹具——实际 **18 处 / 2 个文件**（上一版注释记的「53 处」已过期）。
  // 两侧入参逐字相同（只少一个 `db`）、返回结构相同，所以夹具是**平移**。
  //
  // 一处不是平移、需要判断的：`rfc328-durable-ownership` 有两处传 `onSettledTx`（裸 tx 回调，
  // 把一笔投影写挂进同一笔结算事务）。中立端口**故意**没有这个逃逸口——它把同事务投影表达成
  // **具名变体**。两处按各自真实意图分别处置（用户 2026-09-11 裁决）：
  //   · 真在断言「投影与结算同生共死」的那条，改走已有的具名变体 `settleCodeHostNode`，
  //     投影从一个只为测试存在的 `errorSummary` 字符串换成真实的 node_run 终态——更贴生产路径；
  //   · 另一处只是**夹具**（把任务推到 done 好让归档用例有料可归），平铺成结算之后的一笔普通写。
  // RFC-359 W8 销账：`sqliteTaskExecutionIntent.ts: 1 → 0` —— `submit` 的 `dbTxSync` 连同方法
  // 本身删除。它 src 侧一直是零调用方（生产准入走 `submitTx` + `taskContinuationAdmission.ts` /
  // `DrizzleTaskExecutionIntentPersistence`），挡着的只有测试夹具；实际清点是 **15 处 / 4 个文件**
  // （上一版注释记的「38 处 / 12 个文件」已过期）。中立孪生 `DrizzleTaskExecutionIntentPersistence
  // .submit` 的入参与它逐字相同（只少一个 `db`），所以夹具是**平移**不是改写：
  // `<module>.intents.submit({ db, ...rest })` → `await submitIntent(db, { ...rest })`。
  // 级联只有一层：三个同步 test / 一个同步夹具函数（`rfc328-codehost-attempt-ledger` 的
  // `fixture`）翻 async，两处 `expect(() => …).toThrow` 翻成 `await expect(…).rejects.toEqual`。
  // RFC-359 W10 销账：`sqliteTaskExecutionIntentAdmission.ts: 1 → 0` —— 自带 `dbTxSync` 的独立
  // 入口 `submitTaskContinuation(db, input)` 删除（src / tests 全仓零调用方；事务内参与者
  // `submitTaskContinuationTx` 保留，它的调用方是 `sqliteTaskDecisionParticipant.ts` 自己的事务）。
  // RFC-359 W8 销账：`sqliteTaskOwnership.ts` 5 → 3 —— 归属端口合一成中立的
  // `taskOwnershipPersistence.ts` 之后，同步 store 的 `releaseAfterStop` / `releaseRecovered`
  // （各一笔 dbTxSync）与 `revokeOldDaemon` 失去了全部调用方，随合一删除。
  // RFC-359 W10 销账：`sqliteTaskOwnership.ts` 3 → 2 —— `revokeExact` 的**事务整个去掉**
  // （不是换原语）：体内是一条 `UPDATE … WHERE (精确 owner 元组 + 期望 revision + state='claimed')
  // RETURNING *`，单语句两个引擎都原子，包一层 BEGIN/COMMIT 不多给任何原子性、只把这条路钉死在
  // 同步面上；中立孪生 `taskOwnershipPersistence.ts#revokeExact` 早就是这个形状。`revokeExactTx`
  // 保留（`services/task.ts` 的 `onTransitionTx` 回调仍在 `setTaskStatus` 那笔同步事务里用它），
  // 但它的中立对等物 `revokeExactOwnerInTx` 已经存在，源终止参与者用的就是那份。
  //
  // 剩下 2 笔的复核结论（W8 写的「3 笔都钉死」已被本轮推翻一笔）：
  //   · `withOwnedTaskTx` —— 调用点从 W8 记的 8 处降到 2 处，且都在
  //     `sqliteTaskExecutionEffect.ts`（W10 删掉三份效应观察者与 gate step 之后 src 侧只剩它）。
  //     它跟着上面 effect 那条的 53 处测试直调一起走。
  //   · `claimPendingIntent` —— **不是技术钉死**：唯一的生产调用链
  //     `taskExecutionModule.claim` → `taskDriverLifecycle.ts:59` 本来就在 async 体里，补一个
  //     `await` 就完；中立孪生 `DrizzleTaskOwnershipPersistence.claimPendingIntent` 已经在跑
  //     PostgreSQL 的 daemon。挡住它的是 ~30 处 `module.claim(...)` 测试直调（含
  //     `expect(() => …).toThrow` 要翻成 `await expect(…).rejects`）。
  'modules/task-execution/infrastructure/sqliteTaskOwnership.ts: 2',
  // RFC-359 W7 销账：`sqliteTerminalMaintenance.ts: 5` + `systemWorkspaceGc.ts: 1` +
  // `taskArchive.ts: 1` + `taskDelete.ts: 1` —— 终态维护认领的三条消费路径（删除 / 归档 /
  // workspace-GC）迁到 `databaseSessionFor(db).transaction(...)` + 中立参与者
  // `terminalMaintenanceClaim.ts`，于是 519 行的同步 store 与它私有的端口文件整体退役。
  // RFC-359 W7 销账：`legacyResourcePackageBundleApply.ts: 4` —— 资源包 apply 的四笔
  // **journal 事务**（claim / recordArtifact / settleFailed / 收敛 CAS）改走
  // `databaseSessionFor(db).transaction`。它们本来就没有参与者按 `DbTxSync` 定型（唯一的
  // `provider.claimInTx` 走本文件既有的 `sqliteMembers` 窄化，与大事务里的
  // `revalidateInTx` / `finalizeInTx` 同一形态），级联只有一层：`recordArtifact` 的契约
  // 收成 `Promise<void>`，生产 prestage 链的三处调用点补 await（I14 record-before-act）。
  // RFC-359 W8 销账：`sqlite/maintenanceRunStore.ts: 4` —— 维护 run 认领 / 租约存储的四笔
  // 同步事务（enqueue / recover / claimNext / deferred-settle）改走
  // `databaseSessionFor(db).transaction(...)`，与 PG 那份 358 行的原生重写合成一份中立实现
  // （`platform/persistence/maintenanceRunStore.ts`）。src 侧零级联：唯一的消费者是
  // `sqlite/systemMaintenanceOperations.ts` 里逐方法 `async X(){ return store.X(...) }` 的
  // 恒等适配器，合一后它整体退役。
  // RFC-359 W8 销账：`taskLifecycle.ts: 4 → 2` —— `transitionNodeRunStatus` / `setNodeRunStatus`
  // 的「有执行上下文」分支（原来两笔 `withOwnedTaskTx`）改走中立事务原语
  // （`withTaskExecutionWrite` + `fenceTaskWrite` + 中立异步 CAS），两个引擎共用一条。
  // 前置是把转移判据 / 错误类型 / 字段白名单下沉成叶子 `platform/persistence/nodeRunLifecycleCore.ts`：
  // 在那之前本文件只要 import 中立孪生就闭出 taskLifecycle → nodeRunLifecycleTransition →
  // services/lifecycle → taskLifecycle（depcheck 变异验证过）。判据在
  // `tests/rfc359-w8-node-run-lifecycle-neutral-transaction.test.ts`（两引擎各 6 条）。
  //
  // 剩下的 2 笔（`setTaskStatus` 的 `withOwnedTaskTx` / `dbTxSync` 两个分支）**钉死**。
  // RFC-359 W10 复核后理由比 W8 记的更硬一层：不止是那 6 处 `onTransitionTx: (tx: DbTxSync, …)`
  // 回调（`composition/taskExecutionPersistence.ts` / `sqliteSourceTerminationParticipant.ts` /
  // `services/task.ts` ×4）——它们的宿主 `writeTaskStatusTx` **同时**是 RFC-333 同步人工门参与者
  // `transitionHumanGateTaskTx`（同文件 :734）的实现体，而后者是端口
  // `HumanGateTaskLifecycle.transitionTx`（同步契约）的唯一实现、由 `composition/humanGate.ts`
  // 经 `legacyHumanGateTaskLifecycle.ts` 装配、在别人的 `dbTxSync` 体内被当参与者调用。
  // 也就是说 `writeTaskStatusTx` 一改异步，要同时翻掉「6 条转移回调链」和「人工门参与者端口」
  // 两条互不相干的链，外加同步的 `appendTaskLifecycleTransitionCommittedEventTx`——属另一刀。
  'platform/persistence/sqlite/taskLifecycle.ts: 2',
  // RFC-359 W10 销账：`services/task.ts: 3 → 0`（整行退出账本）——
  //   · 仓库准备重试前的那笔 `withOwnedTaskTx({ run: () => undefined })` 本来就**没有事务体**、
  //     只是围栏，换成 `withTaskExecutionWrite` + `fenceTaskWrite`（同一次 owner CAS，同一个
  //     `task-execution-stale-owner`）；
  //   · 延后准备的回填投影（tasks 回写 + task_repos + task_space_nodes + prep 行置 done 四件事
  //     同生共死）改走 `withTaskExecutionWrite`，`setNodeRunStatusTx` 换成中立孪生；
  //   · 任务铸行的那笔 459 行大事务（工作流版本复核 + 父任务准入 + tasks/intents 插入 +
  //     created 事件 + branch_started_at 沿父链推进 + task_repos / task_space_nodes /
  //     workgroup_task_state / task_collaborators）改走 `withTaskExecutionWrite`，体内 16 条语句
  //     逐条补 `await`；`appendTaskCreatedCommittedEventTx` → `appendTaskCreatedCommittedEvent`，
  //     `insertWorkgroupTaskStateTx`（签名钉在 `DbTxSync` 上、且本站点是它唯一调用方）内联成
  //     一条 await 过的 INSERT——继续传中立句柄给它会撞上最毒的那一档：PG 上 `.run()` 回一个
  //     没人 await 的 Promise，行静默不落而两边都不抛。
  // 判据在 `tests/rfc359-w10-task-execution-sync-transaction-cutover.test.ts`（两引擎各跑一遍）。
]

function scan(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(rel)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (rel === 'db/txSync.ts') continue // 原语自己的家
      const text = readFileSync(join(SRC, rel), 'utf8')
      // RFC-359 W9 —— 口径修正：`dbTxSync<T>(…)` 也是调用点。
      // 修之前这条正则只认 `dbTxSync(`，于是**带显式泛型参数**的调用整个隐身：全仓 5 处
      // （`legacy/workflow.ts` 2 + `legacy/workgroups.ts` 2 + `sqliteResourcePackageMaintenance.ts` 1）
      // 一处都没被记进账本——`sqliteResourcePackageMaintenance.ts` 因此**从未在账本里出现过**，
      // 而账本的全部预言力就建立在「逐文件逐字相等」上。留着这个洞等于给「想加一笔 SQLite-only
      // 事务又不想惊动账本」留了一个只需多打一对尖括号的后门。
      const sync = (text.match(/\bdbTxSync[<(]/g) ?? []).length
      const owned =
        rel === 'modules/task-execution/infrastructure/sqliteTaskOwnership.ts'
          ? 0 // 同上：`withOwnedTaskTx` 的定义处
          : (text.match(/\bwithOwnedTaskTx\(/g) ?? []).length
      if (sync + owned > 0) out.push(`${rel}: ${sync + owned}`)
    }
  }
  walk('')
  return out.sort()
}

/** 扫到的全部 backend 源文件——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
function corpusFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

describe('RFC-359 —— 同步 SQLite 事务面只降不升', () => {
  test('语料非空：确实扫到了整棵 backend 源码树（扫成 0 说明扫描根失效，此刻零预言力）', () => {
    expect(corpusFiles().length).toBeGreaterThanOrEqual(800)
  })

  test('逐文件调用点数与账本逐字相等（增了是新的单引擎分支，减了是收敛，都要改账本）', () => {
    expect(
      scan(),
      '同步事务面（`dbTxSync` / `withOwnedTaskTx`）的逐文件调用点数与账本不符。' +
        '**增**了说明有人在 SQLite 侧新开了一条 PostgreSQL 走不了的路——改用 ' +
        '`databaseSessionFor(db).transaction(...)` 等中立原语；确有理由就把新增写进账本并说明。' +
        '**减**了说明收敛发生了——把账本一起改小，让这次减少留下一次有署名的提交记录。',
    ).toEqual([...SYNC_TRANSACTION_DEBT])
  })

  test('账本按路径字典序、无重复（清点稳定的前提）', () => {
    const paths = SYNC_TRANSACTION_DEBT.map((row) => row.slice(0, row.lastIndexOf(':')))
    expect(new Set(paths).size, '账本里有重复路径').toBe(paths.length)
    expect([...paths].sort()).toEqual(paths)
  })
})
