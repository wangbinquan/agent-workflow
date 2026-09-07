// RFC-359 W5 —— **双引擎判据缺口**的具名 exact 账本（只降不升，逐字相等）。
//
// # 这份账本是什么
//
// 本轮对 SQLite / PostgreSQL 的 **26 对适配器**做了逐方法只读对账，查出一批「同一件事，一侧
// 有校验、另一侧没有」的**判据缺口**。它们**都还没修**——所以这条守卫落地当天就是绿的，它的
// 作用不是把存量照红，而是把这些缺口从「某次分析的口头结论」变成**可计数、有署名、只降不升**
// 的账本：
//
//   · **新增缺口 ⇒ 红**。又有人只在一个引擎上加了判据，守卫立刻要求你要么两侧都加，要么把
//     新缺口写进账本并说明为什么允许它存在。
//   · **缺口被补上 ⇒ 也红**。缺的那一侧出现了判据，守卫报「这条已补，请从账本删除」——每修
//     一条就必须改一次账本，于是每次收敛都留下一次有署名的提交记录。这是 RFC-359 要的
//     forcing function：「不允许再出现两种数据库一个好一个不好的分支」不能靠人记得。
//   · **锚点漂移 ⇒ 还是红**。见下文「为什么它抗重构」。
//
// RFC-359 收敛完后这份账本应当清空：届时把 `DUAL_ENGINE_PREDICATE_GAPS` 改成 `[]`，判据自然
// 就是钉 0。
//
// # 判据机制：两个方向都断言的「存在性探针」
//
// 一条缺口 = 一个探针，同时断言两件事：
//
//   1. **有判据的那一侧仍然有**（`present` 站点的每个锚点都必须命中）——防的是「锚点漂了但
//      守卫还绿」这个假绿：如果 SQLite 那边把 `assertNotBuiltin` 改名 / 挪走，探针不会因为
//      「两边现在都没有了」而误判成「缺口消失」，它会红并指名是哪个锚点漂了。
//   2. **缺判据的那一侧仍然没有**（`absent` 站点的每个锚点都必须**未**命中）——这是缺口本身。
//
// 只断言第 2 条是不够的：一个被删空 / 改名的文件天然满足「没有这个判据」，账本会静默变绿而
// 缺口其实还在（或者已经不再有意义）。所以每条还带第 3 条:
//
//   3. **`context` 语料下限**：`absent` 站点必须仍然含有若干「对应代码路径还活着」的锚点。
//      文件被删 / 函数被改名 / 那段逻辑被搬走时，探针红在「语料消失」而不是静默通过。
//
// # 为什么它抗重构
//
//   · **锚在语义标识上，不锚行号**。行号一定会漂；锚点是错误码字面量（`call-row-finalized`）、
//     具名函数（`assertNotBuiltin` / `finalizeCanceledTaskWithoutDriver` /
//     `withTaskReviewMutationLock`）、具名参数（`lockProof`）——这些名字改了，说明语义真的动了,
//     那就**应该**红一次让人来对账。
//   · **用 AST，不用文本 grep**。本仓实测过这个坑（`docs/dev-gotchas.md`）：行正则会把讲这条
//     规则的**注释**记成命中，也会把「只剩注释里提了一嘴、真代码早没了」记成还在。这里
//     `identifier` 只数 `ts.Identifier` 节点、`literal` 只数字符串字面量节点，注释和文档天然
//     不参与判据——两个方向都准。
//   · **作用域锚在函数上，不锚整文件**。缺口往往是「同一文件里 A 函数有、B 函数没有」（例如
//     PG 的 resume 有 `call-row-finalized` 门、retry 没有；PG 的 `finalize` 收了 `lockProof`、
//     `resolveCodeHostMutations` 没收）。整文件判据在这些条目上会直接判错。函数名解析本身也是
//     一个抗漂移锚点：函数被改名 / 被删 / 出现同名歧义，探针都红并指名道姓。
//   · **文件路径变了也要报出来**：`corpus floor` 用例逐条检查两侧文件存在且非空，改名 / 删除
//     一律红，不会静默失效。
//
// # 账本里每条缺口的用户可见后果（一句话，逐条也写在 `consequence` 字段里）
//
//   01a/01b 内置工作流在 PG 上可被手动执行 / 被 sync，SQLite 上是 403 `builtin-readonly`。
//   02      父调用节点已终结的子任务，PG 上仍可 retry，SQLite 上被 `call-row-finalized` 拒绝。
//   03      PG 上 code-host 节点结算会覆写已终态的 node_run、也不认 source-termination 围栏。
//   04      PG 上 code-host 恢复不校验接管者代际与静默证据，旧 daemon 的证据也能落账。
//   05      同一次恢复在两个引擎上产出**不同**的 takeover 证明摘要，跨引擎无法互认。
//   06      PG 上「取消一个没有 driver 的任务」不会走完任务收尾，任务停在半终态。
//   07      PG 上取消与其它状态写并发时直接 409，SQLite 会回收竞态并照常完成取消。
//   08      PG 上 daemon 重启恢复后，未消费的 `actor-replay-authorized` 决策不回退成
//           `requires-actor`，重放授权悬空。
//   09      PG 上评审派发无锁无事务，并发派发会重复建 doc_version / 互相覆盖。
//   10      PG 上归档恢复不认 cleanupPlan 里的 archiveRoot，换了归档目录会恢复到错误的位置。
//   11a     PG 上封存 clarify 轮次时用**未翻转**的 round 做 reconcile，条目状态与轮次不一致。
//   11b     PG 上 `askingNodeId` 为空也照写 stop 指令，写出一条指向空节点的指令行。
//   11c     PG 上 answers 传成非数组时不报 `clarify-answers-not-array`，行为与 SQLite 不一致。
//   12      SQLite 上子任务启动缺 5 道亲子准入门，错配的 parent node_run / 深度 / actor 也能起。
//   13a     SQLite 上资源包恢复不校验 committed receipt，回执缺失 / 错配也照样 roll-forward。
//   13b     SQLite 上资源包技能恢复缺代际四分支与路径 / 版本哈希校验，跨代际也会 roll-forward。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { sourceUnit, type SourceUnit } from './census'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * 锚点种类。全部走 AST 节点，注释与文档天然不参与判据。
 *
 * - `identifier`      —— 某个 `ts.Identifier` 的文本恰好等于 `text`（函数名 / 参数名 / 表名…）。
 * - `literal`         —— 某个字符串字面量的文本恰好等于 `text`（错误码 / 状态字面量…）。
 * - `literal-prefix`  —— 某个字符串字面量（含模板串各段）以 `text` 开头。只给
 *                        `` `code:${x}` `` 这种把错误码拼进模板串的写法用；用前缀而不是
 *                        `includes`，避免 `actor-replay-authorized` 误命中
 *                        `actor-replay-authorized-suspended` 这类**互为前缀**的近邻词。
 * - `condition`       —— 某个 `ts.Identifier` 出现在 `if` / 三元的**条件表达式**里。用来钉
 *                        「有没有这道判断」这种形状型判据（值被读了不算，必须被判断）。
 * - `call-arg-object` —— 存在一处对 `text` 的调用，其第 `argIndex` 个实参是**对象字面量**。
 *                        用来钉「传的是就地构造的 effective 值，还是原封不动的那个变量」。
 */
type Anchor =
  | Readonly<{ kind: 'identifier' | 'literal' | 'literal-prefix' | 'condition'; text: string }>
  | Readonly<{ kind: 'call-arg-object'; text: string; argIndex: number }>

/**
 * 一个判据站点：`file` 相对 `packages/backend/src`；`fn` 是由外到内的函数名路径
 * （`null` = 整文件）。函数名路径本身即抗漂移锚点——解析不到 / 解析到多个同名都会红。
 */
type Site = Readonly<{
  file: string
  fn: readonly string[] | null
  anchors: readonly Anchor[]
}>

type PredicateGap = Readonly<{
  /** 稳定 id；账本按它字典序排列。 */
  id: string
  /** 回指本轮 26 对只读对账的编号（1–13），一条发现可能拆成多行探针。 */
  item: number
  /** 缺判据的那一侧。 */
  missingSide: 'postgresql' | 'sqlite'
  /** 有判据的一侧：每个锚点都**必须**命中，否则 = 锚点漂移。 */
  present: readonly Site[]
  /** 缺判据的一侧：`anchors` 一个都**不许**命中（命中 = 缺口已补）。 */
  absent: Site
  /** 语料下限：`absent` 站点必须仍然含有这些锚点，证明对应代码路径还活着。 */
  context: readonly Anchor[]
  /** 一句话的用户可见后果。 */
  consequence: string
}>

/**
 * 双引擎判据缺口账本。**只降不升，逐字相等。**
 *
 * 补上一条 ⇒ 从这里删掉这一行；确需新增一条 ⇒ 在 PR 里说明为什么允许这个缺口存在。
 */
export const DUAL_ENGINE_PREDICATE_GAPS: readonly PredicateGap[] = [
  {
    id: '01a-pg-manual-execution-builtin-workflow',
    item: 1,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts',
        fn: ['assertManualExecutionAllowed'],
        anchors: [{ kind: 'identifier', text: 'assertNotBuiltin' }],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts',
      fn: ['createPostgresqlTaskRouteOperations', 'assertManualExecutionAllowed'],
      anchors: [{ kind: 'identifier', text: 'assertNotBuiltin' }],
    },
    context: [
      { kind: 'identifier', text: 'taskExecutionKind' },
      { kind: 'identifier', text: 'isWorkgroupTask' },
    ],
    consequence: '内置工作流在 PG 上可被手动执行；SQLite 上是 403 builtin-readonly。',
  },
  {
    id: '01b-pg-sync-workflow-builtin-workflow',
    item: 1,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts',
        fn: ['assertTaskSyncable'],
        anchors: [{ kind: 'identifier', text: 'assertNotBuiltin' }],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts',
      fn: ['syncWorkflow'],
      anchors: [{ kind: 'identifier', text: 'assertNotBuiltin' }],
    },
    context: [
      { kind: 'identifier', text: 'taskExecutionKind' },
      { kind: 'literal', text: 'task-host-sync-unsupported' },
    ],
    consequence: '内置工作流在 PG 上可被 sync；SQLite 上是 403 builtin-readonly。',
  },
  {
    id: '02-pg-retry-node-call-row-finalized',
    item: 2,
    missingSide: 'postgresql',
    present: [
      {
        file: 'services/task.ts',
        fn: ['assertChildTaskDrivable'],
        anchors: [{ kind: 'literal', text: 'call-row-finalized' }],
      },
      {
        file: 'services/task.ts',
        fn: ['retryNode'],
        anchors: [{ kind: 'identifier', text: 'assertChildTaskDrivable' }],
      },
      {
        // PG 的 **resume** 有这道门，只有 retry 漏了——这条锚点保证「PG 也知道这个判据」
        // 这件事本身不漂：真要收敛，就是把它接到 retry 上。
        file: 'modules/task-execution/infrastructure/postgresqlChildTaskLifecycleParticipant.ts',
        fn: ['assertResumeAdmission'],
        anchors: [{ kind: 'literal', text: 'call-row-finalized' }],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts',
      fn: ['retryNode'],
      anchors: [
        { kind: 'literal', text: 'call-row-finalized' },
        { kind: 'identifier', text: 'assertChildTaskDrivable' },
      ],
    },
    context: [
      { kind: 'literal', text: 'task-still-running' },
      { kind: 'identifier', text: 'nodeRuns' },
    ],
    consequence: '父调用节点已终结的子任务，PG 上仍可 retry；SQLite 上被 call-row-finalized 拒绝。',
  },
  {
    id: '03-pg-code-host-projection-node-run-cas',
    item: 3,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskExecutionEffectPersistence.ts',
        fn: ['settleCodeHostNode'],
        anchors: [
          { kind: 'identifier', text: 'setNodeRunStatusTx' },
          { kind: 'identifier', text: 'allowedFrom' },
        ],
      },
      {
        file: 'platform/persistence/sqlite/taskLifecycle.ts',
        fn: ['setNodeRunStatusTx'],
        anchors: [
          { kind: 'identifier', text: 'assertNodeRunSourceTerminationAdmission' },
          { kind: 'identifier', text: 'isTerminalNodeRunStatus' },
          { kind: 'literal', text: 'illegal-node-run-transition' },
          { kind: 'literal', text: 'node-run-not-found' },
        ],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskExecutionEffectPersistence.ts',
      fn: ['applyCodeHostProjection'],
      anchors: [
        { kind: 'identifier', text: 'setNodeRunStatusTx' },
        { kind: 'identifier', text: 'assertNodeRunSourceTerminationAdmission' },
        { kind: 'identifier', text: 'isTerminalNodeRunStatus' },
        { kind: 'identifier', text: 'allowedFrom' },
        { kind: 'literal', text: 'illegal-node-run-transition' },
        { kind: 'literal', text: 'node-run-not-found' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'nodeRuns' },
      { kind: 'literal', text: 'task-continuation-stale' },
    ],
    consequence:
      'PG 上 code-host 节点结算手写 update 顶掉了事务内 CAS：会覆写已终态的 node_run，也不认 source-termination 围栏。',
  },
  {
    id: '04-pg-code-host-recovery-lock-proof',
    item: 4,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts',
        fn: ['resolveQuiescedCodeHostMutations'],
        anchors: [
          { kind: 'identifier', text: 'lockProof' },
          { kind: 'identifier', text: 'assertExclusiveDaemonLockProof' },
          {
            kind: 'literal',
            text: 'code-host successor recovery requires a new daemon generation',
          },
          { kind: 'literal', text: 'code-host recovery requires quiescence evidence' },
        ],
      },
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskExecutionRecovery.ts',
        fn: ['finalizeTaskExecutionRecovery'],
        anchors: [{ kind: 'identifier', text: 'lockProof' }],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskExecutionRecovery.ts',
      fn: ['resolveCodeHostMutations'],
      anchors: [
        { kind: 'identifier', text: 'lockProof' },
        { kind: 'identifier', text: 'assertExclusiveDaemonLockProof' },
        { kind: 'literal', text: 'code-host successor recovery requires a new daemon generation' },
        { kind: 'literal', text: 'code-host recovery requires quiescence evidence' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'quiescenceEvidenceDigest' },
      { kind: 'literal', text: 'duplicate code-host recovery resolution' },
    ],
    consequence:
      'PG 上 code-host 恢复不校验接管者代际与静默证据非空，旧 daemon 代际的证据也能落账。',
  },
  {
    id: '05-pg-code-host-evidence-digest-payload',
    item: 5,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskExecutionRecovery.ts',
        fn: ['finalizeTaskExecutionRecovery'],
        anchors: [
          { kind: 'identifier', text: 'codeHostEvidenceDigest' },
          { kind: 'identifier', text: 'descriptor' },
          { kind: 'identifier', text: 'proofCode' },
        ],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskExecutionRecovery.ts',
      fn: ['finalize'],
      anchors: [
        { kind: 'identifier', text: 'descriptor' },
        { kind: 'identifier', text: 'proofCode' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'codeHostEvidenceDigest' },
      { kind: 'identifier', text: 'processEvidenceDigest' },
      { kind: 'identifier', text: 'nodeRunId' },
    ],
    consequence:
      '两侧 codeHostEvidenceDigest 载荷不同（PG 含 nodeRunId 不含 descriptor/proofCode，SQLite 相反）⇒ 同一次恢复产出不同的 takeover 证明摘要。',
  },
  {
    id: '06-pg-source-termination-driverless-finalize',
    item: 6,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts',
        fn: ['createTaskSourceTerminationParticipant'],
        anchors: [{ kind: 'identifier', text: 'finalizeCanceledTaskWithoutDriver' }],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts',
      fn: ['createPostgresqlTaskSourceTerminationParticipant'],
      anchors: [{ kind: 'identifier', text: 'finalizeCanceledTaskWithoutDriver' }],
    },
    context: [
      { kind: 'literal', text: 'no-active-owner' },
      { kind: 'literal', text: 'clear-closed' },
      { kind: 'identifier', text: 'releaseOutcome' },
    ],
    consequence: 'PG 上取消一个没有 driver 的任务只改 receipt，不走任务收尾，任务停在半终态。',
  },
  {
    id: '07-pg-source-termination-cas-race-recovery',
    item: 7,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts',
        fn: ['applyOne'],
        anchors: [
          { kind: 'literal', text: 'terminal-control-source-race-winner' },
          { kind: 'identifier', text: 'revokeExactTx' },
        ],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts',
      fn: ['applyOne'],
      anchors: [{ kind: 'literal', text: 'terminal-control-source-race-winner' }],
    },
    context: [
      { kind: 'literal', text: 'concurrent-task-transition' },
      { kind: 'identifier', text: 'CANCELABLE' },
    ],
    consequence:
      'PG 上状态 CAS 竞态直接抛 409；SQLite 会复读赢家并照常完成 fence + revoke + terminalize。',
  },
  {
    id: '08-pg-release-recovered-replay-decision-rollback',
    item: 8,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/task-execution/infrastructure/sqliteTaskOwnership.ts',
        fn: ['releaseRecovered'],
        anchors: [{ kind: 'identifier', text: 'terminalizeTaskExecutionIntentsTx' }],
      },
      {
        file: 'modules/task-execution/infrastructure/sqliteTerminalizeExecutionIntent.ts',
        fn: ['terminalizeTaskExecutionIntentsTx'],
        anchors: [
          { kind: 'identifier', text: 'taskExecutionLineageOperationRecords' },
          { kind: 'literal', text: 'actor-replay-authorized' },
          { kind: 'literal', text: 'requires-actor' },
        ],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskOwnershipPersistence.ts',
      fn: ['releaseRecovered'],
      anchors: [
        { kind: 'identifier', text: 'taskExecutionLineageOperationRecords' },
        { kind: 'identifier', text: 'terminalizeTaskExecutionIntentsInTx' },
        { kind: 'literal', text: 'requires-actor' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'taskExecutionIntents' },
      { kind: 'literal', text: 'daemon-restart-recovered' },
    ],
    consequence:
      'PG 上 daemon 重启恢复后，未消费的 actor-replay-authorized 决策不回退成 requires-actor，重放授权悬空。',
  },
  {
    id: '09-pg-review-dispatch-mutation-lock',
    item: 9,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/collaboration/infrastructure/legacySqliteReview.ts',
        fn: ['dispatchReviewNode'],
        anchors: [{ kind: 'identifier', text: 'withTaskReviewMutationLock' }],
      },
    ],
    absent: {
      file: 'modules/collaboration/infrastructure/postgresqlCollaborationRuntimeMechanics.ts',
      fn: ['dispatchPostgresqlReviewNode'],
      anchors: [
        { kind: 'identifier', text: 'withTaskReviewMutationLock' },
        { kind: 'identifier', text: 'withPostgresqlSerializableTaskExecution' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'docVersions' },
      { kind: 'identifier', text: 'migrateWorkflowDefinitionToLatest' },
    ],
    consequence: 'PG 上评审派发全程无锁无事务，并发派发会重复建 doc_version / 互相覆盖。',
  },
  {
    id: '10-pg-archive-recovery-root-fence',
    item: 10,
    missingSide: 'postgresql',
    present: [
      {
        file: 'services/taskArchive.ts',
        fn: ['recoverInterruptedArchives'],
        anchors: [
          { kind: 'identifier', text: 'parseArchiveCleanupPlan' },
          { kind: 'identifier', text: 'cleanupPlanJson' },
          { kind: 'identifier', text: 'archiveRoot' },
        ],
      },
    ],
    absent: {
      file: 'modules/task-execution/infrastructure/postgresqlTaskArchiveMaintenanceCommand.ts',
      fn: ['recoverCompletedIo'],
      anchors: [
        { kind: 'identifier', text: 'parseArchiveCleanupPlan' },
        { kind: 'identifier', text: 'cleanupPlanJson' },
        { kind: 'identifier', text: 'archiveRoot' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'archiveDir' },
      { kind: 'identifier', text: 'rootTaskId' },
      { kind: 'identifier', text: 'listRecoverable' },
    ],
    consequence:
      'PG 上归档恢复直接拼 options.archiveDir、从不读 cleanupPlanJson，换了归档目录会恢复到错误的位置。',
  },
  {
    id: '11a-pg-clarify-seal-reconcile-effective-round',
    item: 11,
    missingSide: 'postgresql',
    present: [
      {
        // SQLite 用**就地构造的 effective round**（`{...round, status/answersJson/answeredAt}`）
        // 做 reconcile，且放在状态翻转的写之后。
        file: 'modules/collaboration/infrastructure/legacySqliteClarify/seal.ts',
        fn: ['sealRoundQuestions'],
        anchors: [
          { kind: 'call-arg-object', text: 'reconcileRoundEntriesTx', argIndex: 1 },
          { kind: 'identifier', text: 'fullySealed' },
        ],
      },
    ],
    absent: {
      // PG 把 reconcile 放在所有写**之前**，且直接传未修改的 `round`（裸标识符，不是对象字面量）。
      file: 'modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts',
      fn: ['sealPostgresqlClarifyQuestions'],
      anchors: [{ kind: 'call-arg-object', text: 'reconcilePostgresqlRoundEntries', argIndex: 1 }],
    },
    context: [
      { kind: 'identifier', text: 'reconcilePostgresqlRoundEntries' },
      { kind: 'identifier', text: 'clarifyRounds' },
      { kind: 'identifier', text: 'flipNow' },
    ],
    consequence: 'PG 上封存 clarify 轮次时用未翻转的 round 做 reconcile，条目状态与轮次不一致。',
  },
  {
    id: '11b-pg-clarify-seal-asking-node-guard',
    item: 11,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/collaboration/infrastructure/legacySqliteClarify/seal.ts',
        fn: ['sealRoundQuestions'],
        anchors: [
          { kind: 'condition', text: 'askingNodeId' },
          { kind: 'identifier', text: 'setNodeClarifyDirectiveTx' },
        ],
      },
    ],
    absent: {
      file: 'modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts',
      fn: ['sealPostgresqlClarifyQuestions'],
      anchors: [{ kind: 'condition', text: 'askingNodeId' }],
    },
    context: [
      { kind: 'identifier', text: 'askingNodeId' },
      { kind: 'identifier', text: 'taskNodeClarifyDirectives' },
      { kind: 'literal', text: 'stop' },
    ],
    consequence: 'PG 上 askingNodeId 为空也照写 stop 指令，写出一条指向空节点的指令行。',
  },
  {
    id: '11c-pg-clarify-seal-answers-not-array',
    item: 11,
    missingSide: 'postgresql',
    present: [
      {
        file: 'modules/collaboration/infrastructure/legacySqliteClarify/service.ts',
        fn: ['sealAnswersServerSide'],
        anchors: [{ kind: 'literal', text: 'clarify-answers-not-array' }],
      },
    ],
    absent: {
      file: 'modules/collaboration/infrastructure/postgresqlCollaborationRouteOperations.ts',
      fn: ['sealAnswers'],
      anchors: [{ kind: 'literal', text: 'clarify-answers-not-array' }],
    },
    context: [
      { kind: 'literal', text: 'clarify-answer-malformed' },
      { kind: 'identifier', text: 'questionId' },
    ],
    consequence:
      'PG 上 answers 传成非数组时不报 clarify-answers-not-array，错误面与 SQLite 不一致。',
  },
  {
    id: '12-sqlite-child-launch-parent-admission',
    item: 12,
    missingSide: 'sqlite',
    present: [
      {
        file: 'modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations.ts',
        fn: ['assertParentAdmission'],
        anchors: [
          { kind: 'literal', text: 'parent-node-run-task-mismatch' },
          { kind: 'literal', text: 'parent-node-run-not-running' },
          { kind: 'literal', text: 'child-task-reservation-mismatch' },
          { kind: 'literal', text: 'child-invocation-depth-mismatch' },
          { kind: 'literal', text: 'child-launch-actor-mismatch' },
        ],
      },
    ],
    absent: {
      file: 'services/task.ts',
      fn: ['startTaskImpl'],
      anchors: [
        { kind: 'literal', text: 'parent-node-run-task-mismatch' },
        { kind: 'literal', text: 'parent-node-run-not-running' },
        { kind: 'literal', text: 'child-task-reservation-mismatch' },
        { kind: 'literal', text: 'child-invocation-depth-mismatch' },
        { kind: 'literal', text: 'child-launch-actor-mismatch' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'callLaunch' },
      { kind: 'literal', text: 'parent-task-not-found' },
      { kind: 'literal', text: 'parent-task-not-running' },
    ],
    consequence:
      'SQLite 上子任务启动缺 5 道亲子准入门，错配的 parent node_run / 子任务预留 / 调用深度 / actor 也能起。',
  },
  {
    id: '13a-sqlite-resource-package-receipt-gate',
    item: 13,
    missingSide: 'sqlite',
    present: [
      {
        file: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
        fn: ['parseReceipt'],
        anchors: [
          { kind: 'literal-prefix', text: 'resource-package-committed-receipt-missing' },
          { kind: 'literal-prefix', text: 'resource-package-committed-receipt-mismatch' },
        ],
      },
    ],
    absent: {
      file: 'modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts',
      fn: null,
      anchors: [
        { kind: 'literal-prefix', text: 'resource-package-committed-receipt-missing' },
        { kind: 'literal-prefix', text: 'resource-package-committed-receipt-mismatch' },
        { kind: 'identifier', text: 'parseReceipt' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'receiptJson' },
      { kind: 'identifier', text: 'rollForwardArtifacts' },
    ],
    consequence:
      'SQLite 上资源包恢复不校验 committed receipt，回执缺失 / 与 journal 错配也照样 roll-forward。',
  },
  {
    id: '13b-sqlite-resource-package-skill-disposition',
    item: 13,
    missingSide: 'sqlite',
    present: [
      {
        file: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
        fn: ['postgresqlResourcePackageSkillRecoveryDisposition'],
        anchors: [
          { kind: 'literal', text: 'cleanup-deleted' },
          { kind: 'literal', text: 'cleanup-superseded' },
          { kind: 'literal', text: 'roll-forward-current' },
          { kind: 'literal', text: 'reject-missing-generation' },
        ],
      },
      {
        file: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
        fn: ['assertSkillArtifactPaths'],
        anchors: [{ kind: 'literal', text: 'resource-package-skill-artifact-path-mismatch' }],
      },
      {
        file: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
        fn: ['rollForwardSkillArtifact'],
        anchors: [
          { kind: 'identifier', text: 'postgresqlResourcePackageSkillRecoveryDisposition' },
          { kind: 'literal', text: 'resource-package-skill-version-hash-mismatch' },
        ],
      },
    ],
    absent: {
      file: 'modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts',
      fn: null,
      anchors: [
        { kind: 'literal', text: 'cleanup-superseded' },
        { kind: 'literal', text: 'reject-missing-generation' },
        { kind: 'literal', text: 'resource-package-skill-artifact-path-mismatch' },
        { kind: 'literal', text: 'resource-package-skill-version-hash-mismatch' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'hashRegularFileTree' },
      { kind: 'literal', text: 'resource-package-skill-live-hash-mismatch' },
    ],
    consequence:
      'SQLite 上资源包技能恢复缺代际四分支与路径 / 版本哈希校验，跨代际的产物也会被 roll-forward。',
  },
]

// ---------------------------------------------------------------------------
// AST 判据内核
// ---------------------------------------------------------------------------

const unitCache = new Map<string, SourceUnit | null>()

function unitOf(file: string): SourceUnit | null {
  const cached = unitCache.get(file)
  if (cached !== undefined) return cached
  const abs = resolve(SRC, file)
  const unit = existsSync(abs) ? sourceUnit(abs, readFileSync(abs, 'utf8')) : null
  unitCache.set(file, unit)
  return unit
}

/** 与 `probe.ts` 同口径：函数声明 / 方法 / 变量或属性上的函数表达式与箭头函数。 */
function declaredFunctionName(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name === undefined ? null : node.name.getText(source)
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(source)
    return null
  }
  return null
}

type ScopeResolution =
  | Readonly<{ ok: true; node: ts.Node }>
  | Readonly<{ ok: false; reason: string }>

/**
 * 按由外到内的函数名路径解析作用域。
 *
 * 同名冲突取**最浅**的那个声明：本仓的适配器普遍写成「顶层实现 + 工厂对象里一行同名委派」
 * （`syncWorkflow: (input) => syncWorkflow(dependencies, input)`），委派行不是第二份实现，
 * 判据当然要落在实现上。要指名更深的那一个，就把外层函数名写进路径（例如
 * `['createPostgresqlTaskRouteOperations', 'assertManualExecutionAllowed']`）。
 *
 * 解析不到、或**同一深度**上解析到多个同名函数，一律判为**锚点漂移**并原样报出来——
 * 这正是「文件路径 / 函数名变了要能明确报出来而不是静默失效」那条要求。
 */
function resolveScope(unit: SourceUnit, path: readonly string[] | null): ScopeResolution {
  let current: ts.Node = unit.source
  for (const segment of path ?? []) {
    const matches: Array<{ node: ts.Node; depth: number }> = []
    const walk = (node: ts.Node, depth: number): void => {
      if (node !== current && declaredFunctionName(node, unit.source) === segment) {
        matches.push({ node, depth })
        return // 不再深入：同名嵌套按最外层算
      }
      ts.forEachChild(node, (child) => walk(child, depth + 1))
    }
    ts.forEachChild(current, (child) => walk(child, 1))
    if (matches.length === 0) {
      return { ok: false, reason: `函数 '${segment}' 在 ${unit.path} 里已不存在（锚点漂移）` }
    }
    const shallowest = Math.min(...matches.map((match) => match.depth))
    const outermost = matches.filter((match) => match.depth === shallowest)
    if (outermost.length > 1) {
      return {
        ok: false,
        reason: `函数名 '${segment}' 在 ${unit.path} 里有 ${outermost.length} 个同深度同名声明，作用域不再唯一（锚点漂移）`,
      }
    }
    current = (outermost[0] as { node: ts.Node }).node
  }
  return { ok: true, node: current }
}

/** 作用域内所有字符串字面量文本（含模板串各段）。注释不在其中。 */
function literalTexts(scope: ts.Node): string[] {
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      out.push((node as ts.TemplateLiteralLikeNode).text)
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

function identifierTexts(scope: ts.Node): Set<string> {
  const out = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.add(node.text)
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

/** `if` / 三元的**条件表达式**里出现的标识符。「读了这个值」不算，必须「判断了这个值」。 */
function conditionIdentifiers(scope: ts.Node): Set<string> {
  const out = new Set<string>()
  const collect = (expression: ts.Node): void => {
    for (const name of identifierTexts(expression)) out.add(name)
  }
  const walk = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) collect(node.expression)
    else if (ts.isConditionalExpression(node)) collect(node.condition)
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

/** 调用 `name(…)` 且第 `argIndex` 个实参是对象字面量。callee 取最后一段标识符。 */
function hasCallWithObjectArgument(scope: ts.Node, name: string, argIndex: number): boolean {
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      const argument = node.arguments[argIndex]
      if (calleeName === name && argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return found
}

function anchorLabel(anchor: Anchor): string {
  return anchor.kind === 'call-arg-object'
    ? `call-arg-object ${anchor.text}(#${anchor.argIndex} = object literal)`
    : `${anchor.kind} ${JSON.stringify(anchor.text)}`
}

function anchorPresent(scope: ts.Node, anchor: Anchor): boolean {
  switch (anchor.kind) {
    case 'identifier':
      return identifierTexts(scope).has(anchor.text)
    case 'literal':
      return literalTexts(scope).includes(anchor.text)
    case 'literal-prefix':
      return literalTexts(scope).some((text) => text.startsWith(anchor.text))
    case 'condition':
      return conditionIdentifiers(scope).has(anchor.text)
    case 'call-arg-object':
      return hasCallWithObjectArgument(scope, anchor.text, anchor.argIndex)
  }
}

type SiteReport = Readonly<{
  /** 站点解析失败（文件缺失 / 函数名漂移）时的原因；解析成功为 null。 */
  drift: string | null
  /** 命中的锚点标签。 */
  hits: readonly string[]
  /** 未命中的锚点标签。 */
  misses: readonly string[]
}>

function inspect(site: Site, extraAnchors: readonly Anchor[] = []): SiteReport {
  const unit = unitOf(site.file)
  if (unit === null) {
    return { drift: `文件 ${site.file} 不存在（被改名或删除）`, hits: [], misses: [] }
  }
  if (unit.text.trim().length === 0) {
    return { drift: `文件 ${site.file} 为空`, hits: [], misses: [] }
  }
  const scope = resolveScope(unit, site.fn)
  if (!scope.ok) return { drift: scope.reason, hits: [], misses: [] }
  const hits: string[] = []
  const misses: string[] = []
  for (const anchor of [...site.anchors, ...extraAnchors]) {
    ;(anchorPresent(scope.node, anchor) ? hits : misses).push(anchorLabel(anchor))
  }
  return { drift: null, hits, misses }
}

/** 一条缺口的实测结论：`open` = 缺口仍在（账本应当收录它）。 */
type Measurement = Readonly<{ id: string; open: boolean; failures: readonly string[] }>

function measure(gap: PredicateGap): Measurement {
  const failures: string[] = []

  // (1) 有判据的一侧：锚点必须全在，否则 = 漂移，不能当成「缺口消失」。
  for (const site of gap.present) {
    const report = inspect(site)
    if (report.drift !== null) {
      failures.push(
        `[${gap.id}] 有判据的一侧锚点漂移：${report.drift}。请把账本重新指到判据的新位置（不要因为「两边现在都没有」就删掉这一条）。`,
      )
      continue
    }
    for (const miss of report.misses) {
      failures.push(
        `[${gap.id}] 有判据的一侧 ${site.file}${site.fn === null ? '' : ` > ${site.fn.join(' > ')}`} 已经找不到锚点 ${miss}。要么判据真的被删了（那是回归，先修代码），要么它被重命名 / 搬家了（那就更新账本的锚点）。`,
      )
    }
  }

  // (2) 缺判据的一侧：语料下限先行——语料没了，红在语料上，不许静默变绿。
  const absent = inspect(gap.absent, gap.context)
  if (absent.drift !== null) {
    failures.push(
      `[${gap.id}] 缺判据的一侧语料消失：${absent.drift}。这条缺口的对账锚点已失效，请重新对账后更新账本。`,
    )
    return { id: gap.id, open: failures.length === 0, failures }
  }
  const contextLabels = new Set(gap.context.map(anchorLabel))
  for (const miss of absent.misses.filter((label) => contextLabels.has(label))) {
    failures.push(
      `[${gap.id}] 缺判据的一侧 ${gap.absent.file}${gap.absent.fn === null ? '' : ` > ${gap.absent.fn.join(' > ')}`} 已经不含语料锚点 ${miss}——对应代码路径被搬走或改写了，守卫会因此假绿。请重新对账后更新账本。`,
    )
  }

  // (3) 缺口本身：缺的那一侧一个判据锚点都不许命中。
  const closed = absent.hits.filter((label) => !contextLabels.has(label))
  return {
    id: gap.id,
    open: closed.length === 0,
    failures: [
      ...failures,
      ...closed.map(
        (label) =>
          `[${gap.id}] 缺口已补：${gap.absent.file}${gap.absent.fn === null ? '' : ` > ${gap.absent.fn.join(' > ')}`} 现在含有 ${label}。请把这一条从 DUAL_ENGINE_PREDICATE_GAPS 里**删掉**（账本只降不升，每补一条就改小一次）。`,
      ),
    ],
  }
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe('RFC-359 W5 — 双引擎判据缺口 exact 账本', () => {
  test('账本按 id 字典序排列且无重复', () => {
    const ids = DUAL_ENGINE_PREDICATE_GAPS.map((gap) => gap.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toEqual([...new Set(ids)])
  })

  test('每条缺口都指向两个真实存在、非空的文件（改名 / 删除必须红，不许静默变绿）', () => {
    const missing: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of [...gap.present, gap.absent]) {
        const unit = unitOf(site.file)
        if (unit === null) missing.push(`[${gap.id}] ${site.file} 不存在（被改名或删除）`)
        else if (unit.text.trim().length === 0) missing.push(`[${gap.id}] ${site.file} 为空`)
      }
    }
    expect(missing).toEqual([])
  })

  test('每条缺口的两侧作用域都能解析到唯一函数（函数改名 / 同名歧义都算锚点漂移）', () => {
    const drifted: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of [...gap.present, gap.absent]) {
        const unit = unitOf(site.file)
        if (unit === null) continue // 上一条用例已经报过
        const scope = resolveScope(unit, site.fn)
        if (!scope.ok) drifted.push(`[${gap.id}] ${scope.reason}`)
      }
    }
    expect(drifted).toEqual([])
  })

  test('每条缺口的语料下限成立：缺判据的一侧仍含 context 锚点', () => {
    const eroded: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      const report = inspect({ ...gap.absent, anchors: [] }, gap.context)
      if (report.drift !== null) {
        eroded.push(`[${gap.id}] ${report.drift}`)
        continue
      }
      for (const miss of report.misses) {
        eroded.push(`[${gap.id}] ${gap.absent.file} 已不含语料锚点 ${miss}`)
      }
    }
    expect(eroded).toEqual([])
  })

  test('每条缺口的「有判据一侧」锚点都还在（防止两边都没有时假绿）', () => {
    const drifted: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of gap.present) {
        const report = inspect(site)
        if (report.drift !== null) {
          drifted.push(`[${gap.id}] ${report.drift}`)
          continue
        }
        for (const miss of report.misses) {
          drifted.push(
            `[${gap.id}] ${site.file} > ${(site.fn ?? ['<file>']).join(' > ')} 已找不到锚点 ${miss}`,
          )
        }
      }
    }
    expect(drifted).toEqual([])
  })

  test('实测缺口集合与账本逐字相等（补上了就删除这一条；新增缺口要说明为什么）', () => {
    const measurements = DUAL_ENGINE_PREDICATE_GAPS.map(measure)
    const failures = measurements.flatMap((measurement) => measurement.failures)
    expect(failures).toEqual([])

    const measured = measurements
      .filter((measurement) => measurement.open)
      .map((measurement) => measurement.id)
    expect(measured).toEqual(DUAL_ENGINE_PREDICATE_GAPS.map((gap) => gap.id))
  })

  test('账本条目自身自洽：id 前缀与 item 编号对应，且两侧属于不同引擎', () => {
    const problems: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      const prefix = gap.id.split('-')[0] ?? ''
      if (!prefix.startsWith(String(gap.item).padStart(2, '0'))) {
        problems.push(`[${gap.id}] id 前缀与 item=${gap.item} 不对应`)
      }
      if (gap.consequence.trim().length === 0) problems.push(`[${gap.id}] 缺少用户可见后果说明`)
      const absentIsPostgresql = /postgresql/i.test(gap.absent.file)
      if (absentIsPostgresql !== (gap.missingSide === 'postgresql')) {
        problems.push(
          `[${gap.id}] missingSide='${gap.missingSide}' 与 absent 文件 ${gap.absent.file} 不符`,
        )
      }
    }
    expect(problems).toEqual([])
  })
})
