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
  // RFC-359 W7 销账：`legacySqliteClarifyRounds.ts: 1`（澄清草稿的读改写）+
  // `legacySqliteTaskQuestions.ts: 3`（改派的三处 CAS/读改写）+
  // `sqliteCollaborationWorkgroupClarify.ts: 1`（自治遣散）—— 三个文件是
  // `CollaborationRouteOperations` / `CollaborationRuntimeMechanics` 两对适配器合一时被
  // 转发到的正典实现，写事务改走 `databaseSessionFor(db).transaction(...)` + 中立的
  // `setNodeRunStatusTx`，于是 PG 侧那两份共 4016 行的原生重写整体退役。
  // RFC-359 W9 销账：`legacySqliteTaskCollab.ts: 1 → 0` —— 任务成员全量替换
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
  'modules/resource-catalog/infrastructure/legacy/agent.ts: 5',
  'modules/resource-catalog/infrastructure/legacy/importRefs.ts: 1',
  'modules/resource-catalog/infrastructure/legacy/workflow.ts: 2',
  'modules/resource-catalog/infrastructure/legacy/workgroup/state.ts: 1',
  'modules/resource-catalog/infrastructure/legacy/workgroups.ts: 2',
  'modules/task-execution/infrastructure/sqliteProcessEffectObserver.ts: 1',
  'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts: 3',
  // RFC-359 W8 销账：`sqliteTaskExecutionEffect.ts` 5 → 4 —— `resolveQuiescedCodeHostMutations`
  // （唯一调用方是合一前的 SQLite 恢复流程）迁进两引擎共用的 `effectQuiescence.ts`，同时把
  // 那条钉死在 `DbTxSync` 上的 `onAppliedTx` 回调（node_run 投影）收成实现的一部分。
  // RFC-359 W8 销账：`sqliteTaskExecutionEffect.ts` 4 → 3 —— 同步 store 上的
  // `resolveQuiescedManagedProcesses`（自带一笔 `dbTxSync`）与
  // `closeRecoveredOutcomeUnknownAndRelease` 自 W1-T7b 起就没有调用方（清算只剩
  // `effectQuiescence.ts` 那一份中立实现），随 effect 账本端口合一一并删除。
  'modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts: 3',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntent.ts: 1',
  'modules/task-execution/infrastructure/sqliteTaskExecutionIntentAdmission.ts: 1',
  // RFC-359 W8 销账：`sqliteTaskOwnership.ts` 5 → 3 —— 归属端口合一成中立的
  // `taskOwnershipPersistence.ts` 之后，同步 store 的 `releaseAfterStop` / `releaseRecovered`
  // （各一笔 dbTxSync）与 `revokeOldDaemon` 失去了全部调用方，随合一删除。
  // 剩下的 3 笔按 D28b 判据都**钉死**、不能改异步：`claimPendingIntent`（`taskExecutionModule.claim`
  // → `taskDriverLifecycle.ts` 的同步认领）、`withOwnedTaskTx`（回调签名就是 `DbTxSync`，8 处生产
  // 调用点在 `services/task.ts` / `platform/persistence/sqlite/taskLifecycle.ts` 等处）、
  // `revokeExact`（体内的 `revokeExactTx` 是 `sqliteSourceTerminationParticipant.ts` /
  // `services/task.ts` 的同步事务内参与者）。
  'modules/task-execution/infrastructure/sqliteTaskOwnership.ts: 3',
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
  // 剩下的 2 笔（`setTaskStatus` 的 `withOwnedTaskTx` / `dbTxSync` 两个分支）按 D28b 判据**钉死**：
  // 体内是同步的 `writeTaskStatusTx`，而它的 `onTransitionTx: (tx: DbTxSync, …) => void` 回调
  // 被 6 处生产站点传入（`taskExecutionPersistence.ts` / `sqliteSourceTerminationParticipant.ts` /
  // `services/task.ts` ×4），改中立要连着那条参与者链一起动——属另一刀。
  'platform/persistence/sqlite/taskLifecycle.ts: 2',
  'services/task.ts: 3',
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
      const sync = (text.match(/\bdbTxSync\(/g) ?? []).length
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
