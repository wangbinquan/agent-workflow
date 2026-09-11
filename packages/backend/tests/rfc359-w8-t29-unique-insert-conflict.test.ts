// RFC-359 W8-T29 —— 「先查存在、再插入唯一键表」这一族在**并发**下的用户可见收场，两个引擎各跑一遍。
//
// 这个文件为什么存在
// ---------------------------------------------------------------------------
// design §10.1.1 的 W8 普查给出一类形状：一笔事务里先读一眼某张带唯一约束的表（「有没有同名的？」
// 「当前最大序号是多少？」），按读到的结果决定写什么，再往同一张表 insert。SQLite 上写事务是
// 进程内单写者租约 + `BEGIN IMMEDIATE`，前置检查恒命中；PostgreSQL 上两个用户并发时前置检查
// 可能双双落空，后一笔撞唯一索引抛 **23505**，而 23505 不是 40001、不被 `retryPostgresqlSerialization`
// 认，于是裸驱动错误冒到 HTTP 边界变成 **500**。
//
// 普查把四处标成 Tier A（「前置检查本就返回域内 4xx、两个普通用户即可撞上」）。
// **本文件把这四处逐处实测了一遍，结论是四处全部不可达**——每一处都已经被某个机制兜住，
// 而那些机制此前没有任何测试钉住。下面每条用例锁的就是「兜住它的到底是什么」：这些断言今天全绿，
// 但把对应机制拿掉就会红（变异表在下面），所以它们不是重复劳动，是把「为什么这里没炸」写成可执行的事实。
//
// 逐处结论（详见各 test 的注释）
// ---------------------------------------------------------------------------
//   ① `repositoryWorkspaceStore.createRepositoryGroup` —— **不可达**。事务是 `.transaction()`
//      （PG 的 READ COMMITTED），但读之前先取了 `engineOf(tx).advisoryLock(tx,
//      'source-control:repository-groups')`。READ COMMITTED 每条语句取新快照，输家等到锁之后那条
//      SELECT 就看得见赢家已提交的行 ⇒ 干净的 `name-conflict` → 409。
//   ② `taskContinuationAdmission` 的 pending-intent 插入 —— **不可达**。生产入口把它塞进
//      SERIALIZABLE（`.serializable()` / `withPostgresqlSerializableTaskExecution`），PG 的 SSI 先给
//      输家 40001，而 `serializable()` 的重试单位是**整笔事务**：重跑取新快照，活跃 intent 这才读得到
//      ⇒ `task-continuation-conflict`。（生产路径上还有一道更早的 task 行 CAS，见 test 注释。）
//   ③ `humanGateOpenParticipant.projectClarifyGateOpen` 的 taskQuestions 插入 —— **不可达**，
//      而且不是被唯一索引兜住的。三条依据叠在一起：(a) 事务由
//      `humanGateTaskLifecyclePersistence.parkPrepared` 的 `withTaskExecutionSerializable` 打开，
//      即 SERIALIZABLE + 40001 整笔重放，与 ② 同一个机制；(b) 同一 gate 的第二笔 open 在
//      `humanGateOperationJournal.beginTx` 就被挡下——那里先 `engineOf(tx).lockAggregateRoot(tx,
//      tasks, tasks.id, taskId)` 再查活跃操作，命中即 `human-gate-operation-conflict`；
//      (c) mint 模式下 `originNodeRunId` 就是新铸的 operationId，身份天然不撞，只有 reuse 模式
//      （同一 shardKey 的重复追问）才可能撞，而那正是 (b) 挡住的那一条。本文件**不给它单独立用例**：
//      要造出两笔同 gate 的 clarify-open 必须把整条节点执行链跑起来（`nodeMechanics` 的
//      `openAgentClarify`），构造成本与预言力不成比例；② 已经把同一个机制（SERIALIZABLE 重放）
//      在同一族形状上钉住了。
//   ④ `legacy/skillVersion.commitSkillVersionInTx` 的版本号自增 —— **不可达**。同一条路径在
//      `stageSkillVersion` → `beginOperation` → `acquireOpLocks` 先抢 `skill_operation_locks` 的排他行，
//      **那处的唯一冲突已经归一**成 `ConflictError('skill-operation-busy')`。普查笔记把这处归一说成
//      「在另一条路径上」——不对，它就在同一条路径的上游，是这处的守门人。
//
// 顺带把 Tier B 里被点名要优先复核的**事件骨干**也钉住（第 5 条）：`platform/events/committed/append.ts`
// 的 `reserveAggregateSequence` 在读 heads 之前取 **per-aggregate** 的 advisory lock，两个引擎、
// 两种 opener 下同一聚合的两条并发追加都拿到 seq 1 / 2。**不是**「任何一次 committed-event 追加都会 500」。
//
// 第 6 条是这一族的判据本身（微实验，不指向任何生产路径）：**SERIALIZABLE 能不能兜住，取决于两笔
// 事务有没有读过它们要插的那张表**——那次读留下的谓词锁（SIREAD）才让插入成为可检测的读写冲突。
// 判据来自**另一张**表时 SSI 无处挂冲突，btree 直接抛裸唯一冲突。这条解释了为什么
// `mcpRuntimeTestPersistence.appendEvent`（读 turns 算序号、插 events）在 SERIALIZABLE 里照样炸，
// 而本文件测的四处不炸。
//
// 变异表（本次落地实测，`AW_TEST_POSTGRESQL_URL` 指向真库）
// ---------------------------------------------------------------------------
// | # | 变异 | 结果 |
// |---|------|------|
// | ① | 删掉 `createRepositoryGroup` 读之前那行 `engineOf(tx).advisoryLock` | **PG 红**（裸 23505，12/12 轮）、SQLite 绿 |
// | ② | `DrizzleTaskExecutionIntentPersistence.submit` 的 opener 从 `.serializable()` 降成 `.transaction()` | **PG 红**（裸 23505，120/120 轮）、SQLite 绿 |
// | ④ | `acquireOpLocks` 的 `isUniqueViolation(...)` 判据永远为假（归一失效） | **两个引擎都红**（SQLite `SQLITE_CONSTRAINT_PRIMARYKEY` / PG 裸 23505，6/6 轮） |
// | ⑤ | 删掉 `reserveAggregateSequence` 的 `advisoryLock` | READ COMMITTED 下 **PG 红**（裸 23505，25/25 轮）、SQLite 绿；SERIALIZABLE 下仍绿（SSI 兜住） |
// | ⑥ | 把微实验的前置读换成读**另一张**表 | **两个引擎都红**（SQLite 唯一约束 / PG 裸 23505，20/20 轮） |
//
// ③ 没有单独的变异行：它的守门人（`beginTx` 的活跃操作检查）不在本文件的被测面里，理由见上。
//
// 相关：架构账本 `tests/architecture/rfc359-w8-t29-unnormalized-unique-insert.test.ts` 数「这个形状
// 还剩几处」，本文件回答「其中哪几处真会咬人」——两半合起来才是一条完整的判据（同 W6-T28 的分工）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  cachedRepos,
  committedEventFamilyCutovers,
  mcps,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { LineageSlot } from '@/modules/task-execution/domain/executionIntent'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import type { SkillOperationContext } from '@/modules/resource-catalog/public/participants'
import { DrizzleRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import type { RepositoryGroupNodeRecord } from '@/modules/source-control/public/operations'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { postgresqlUniqueViolationConstraint } from '../src/platform/persistence/capabilities'
import { describeEachProvider } from './helpers/eachProvider'
import { composeTestSkillCatalog } from './helpers/skillCatalog'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

/**
 * 拒因的可读形态：领域错误报 `code`，别的（含原始驱动错误）原样带出来。
 * 断言失败时要一眼看出「这是 409 还是 500」——裸驱动错误的 message 里带着 `Failed query: insert into …`。
 */
function rejectionShape(reason: unknown): string {
  const named = reason as { name?: string; code?: string; message?: string }
  if (typeof named?.code === 'string') return `${String(named.name)}:${named.code}`
  // 裸驱动错误：把**为什么没被翻成领域错误**一并带出来。只报 message 的话，断言 diff 里只有
  // 「Failed query: insert into …」，看不出 SQLSTATE、也看不出能力矩阵怎么判的——2026-09-10
  // 这条红了两次，两次都只能靠猜（第一次猜错了一轮）。三态：`undefined` = 没被认成唯一冲突；
  // `''` = 是唯一冲突但驱动没报名字；非空串 = 约束名 / 列清单。
  const target = postgresqlUniqueViolationConstraint(reason)
  const verdict = target === undefined ? 'not-unique-violation' : `unique:${target || '<unnamed>'}`
  // 2026-09-11 第三次红（`7a4fda4fa` 的 ubuntu shard 8/8）：只报 verdict + 截断的 message 仍然
  // **不足以归因**——看不出那条裸错误到底是 23505 还是 40001/40P01，也看不出 cause 链在哪一层断的。
  // 本机连跑 8 次复现不出来，所以下次只有 CI 日志一次机会。这里把**整条 cause 链**的
  // `name/code/errno/constraint` 一并带出来（每层一段，最多 8 层——与两个分类器的遍历深度一致）。
  // 判据一个字没改，只是让失败自带证据。
  return `${String(named?.name ?? 'unknown')}[${verdict}]${causeChain(reason)}:${String(
    named?.message ?? reason,
  ).slice(0, 160)}`
}

/** 逐层导出 cause 链上的判别字段——两个分类器（唯一冲突 / 序列化冲突）看的就是这几个字段。 */
function causeChain(reason: unknown): string {
  const parts: string[] = []
  let current: unknown = reason
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const node = current as {
      readonly name?: unknown
      readonly code?: unknown
      readonly errno?: unknown
      readonly constraint?: unknown
      readonly cause?: unknown
    }
    parts.push(
      `${depth}:${String(node.name ?? '?')}/code=${String(node.code ?? '-')}` +
        `/errno=${String(node.errno ?? '-')}/constraint=${String(node.constraint ?? '-')}`,
    )
    current = node.cause
  }
  return `{${parts.join(' | ')}}`
}

/** `Promise.allSettled` 的结果归一成可排序的字符串数组（成功侧由调用方给形状）。 */
function settledShapes<T>(
  settled: readonly PromiseSettledResult<T>[],
  ok: (value: T) => string,
): string[] {
  return settled.map((entry) =>
    entry.status === 'fulfilled' ? ok(entry.value) : rejectionShape(entry.reason),
  )
}

async function seedCachedRepo(db: ProviderNeutralDatabase): Promise<string> {
  const id = `cr_${ulid()}`
  await db.insert(cachedRepos).values({
    id,
    urlHash: `h_${id}`,
    urlRedacted: `https://example.invalid/${id}.git`,
    urlEnc: null,
    localPath: `/tmp/mirror/${id}`,
    lastFetchedAt: 1,
    createdAt: 1,
  })
  return id
}

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

async function seedTaskRow(db: ProviderNeutralDatabase): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: id,
    lineageSlotPathJson: canonicalJson(rootPath(id)),
  })
  return id
}

// ---------------------------------------------------------------------------
// ① 仓库组建名（Tier A #1）
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T29 —— 两个用户同时建同名仓库组', (harness) => {
  test('输的一方拿到 name-conflict（→ 409），不是驱动层的唯一键错误', async () => {
    const db = harness.db
    const store = new DrizzleRepositoryWorkspaceStore(db)
    const repo = await seedCachedRepo(db)
    // 单轮就能复现（变异后 PG 每轮必红），12 轮把「刚好被自然串行化」的偶然性排掉。
    for (let round = 0; round < 12; round += 1) {
      const name = `grp-${ulid().toLowerCase()}`
      const create = (tag: string) => {
        const id = `rg-${tag}-${ulid().toLowerCase()}`
        const nodes: RepositoryGroupNodeRecord[] = [
          {
            groupId: id,
            path: 'a',
            attachmentKind: 'repo',
            cachedRepoId: repo,
            childGroupId: null,
            ref: 'main',
            subdir: '',
            readonly: false,
          },
        ]
        return store.createRepositoryGroup(
          {
            id,
            name,
            description: '',
            version: 1,
            createdByUserId: null,
            createdAt: 1,
            updatedAt: 1,
            schemaVersion: 2,
          },
          nodes,
        )
      }
      const settled = await Promise.allSettled([create('a'), create('b')])
      // `services/repoGroup.ts` 把 'name-conflict' 翻成 409 `repo-group-name-conflict`；
      // 裸 23505 冒上去就是 500。
      expect(settledShapes(settled, (value) => value).sort()).toEqual(['created', 'name-conflict'])
      // 库面同样只多一个组。
      const snapshot = await store.readRepositoryGroupSnapshot()
      expect(snapshot.groups.filter((group) => group.name === name)).toHaveLength(1)
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// ② 任务续跑准入（Tier A #2）
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T29 —— 同一个任务上两次并发续跑', (harness) => {
  test('输的一方拿到 task-continuation-conflict，不是驱动层的唯一键错误', async () => {
    const db = harness.db
    // 40 轮：PG 上这条的收场靠 SSI，而 SSI 什么时候先冒 40001、什么时候让唯一索引先抛是有随机性的
    // （`rfc359-w8-t28-mcp-runtime-lost-update` 的 `create` 那条实测 3 轮全绿、40 轮才稳定复现）。
    // 变异（opener 降成 `.transaction()`）后本条 120/120 轮全红，取 40 是够用且仍在秒级的刻度。
    for (let round = 0; round < 40; round += 1) {
      const taskId = await seedTaskRow(db)
      const intents = new DrizzleTaskExecutionIntentPersistence(db)
      // 两个不同 kind ⇒ requestHash 不同 ⇒ 不是幂等重放，是两次真正的「续跑」。
      const submit = (kind: 'resume' | 'retry-node') =>
        intents.submit({
          request: {
            taskId,
            kind,
            source: 'rest',
            actorUserId: 'actor-1',
            expectedTaskRevision: 1,
            scope: {
              executionLineageId: taskId,
              continuationSlotKey: `${taskId}:root`,
              slotPath: rootPath(taskId),
              operationGeneration: 0,
            },
            payload: { v: 1 },
          },
          intentId: `intent_${ulid()}`,
        })
      const settled = await Promise.allSettled([submit('resume'), submit('retry-node')])
      // 生产路径（`postgresqlChildTaskLifecycleParticipant.admitResume` / `services/task.ts` 的
      // `resumeKick`）在同一笔事务里更早还有一次 task 行 CAS（status + lifecycleEventRevision），
      // 输家在那儿就被判 `task-not-resumable`。这里直接打端口，测的是**最里面那道**判据：
      // 活跃 intent 检查 + 部分唯一索引 `idx_task_execution_intents_pending_task`。
      expect(settledShapes(settled, (value) => `ok:${value.state}`).sort()).toEqual([
        'TaskExecutionError:task-continuation-conflict',
        'ok:pending',
      ])
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// ④ 技能保存的版本号自增（Tier A #4）
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T29 —— 同一个技能上两次并发保存', (harness) => {
  test('输的一方拿到 skill-operation-busy（→ 409），根本走不到版本号插入', async () => {
    const db = harness.db
    const { catalog } = composeTestSkillCatalog(db)
    const authority = {
      user: { id: 'u-t29', username: 'u-t29', displayName: 'u', role: 'admin', status: 'active' },
      userId: 'u-t29',
      source: 'session',
      permissions: new Set(['resource-acl:private']),
    } as unknown as SkillOperationContext
    for (let round = 0; round < 6; round += 1) {
      const name = `sk-${ulid().slice(-10).toLowerCase()}`
      const created = await catalog.operations.create.invoke(authority, {
        submission: {
          kind: 'json-body',
          body: JSON.stringify({ name, description: 't29', bodyMd: `# ${name}\n\nbody\n` }),
        },
      })
      const before = await catalog.operations.content.invoke(authority, { id: created.id })
      const save = (tag: string) =>
        catalog.operations.save.invoke(authority, {
          id: created.id,
          submission: {
            kind: 'json-body',
            body: JSON.stringify({
              name,
              description: 't29',
              bodyMd: `# ${name}\n\nrevision ${tag}\n`,
              // 两个标签页手里都是同一个 token——这正是「都以为自己能存」的前提。
              expectedToken: before.token,
            }),
          },
        })
      const settled = await Promise.allSettled([save('a'), save('b')])
      // 守门人是 `legacy/skillOperations.acquireOpLocks`：`skill_operation_locks` 的 PK 冲突
      // **已经**经能力矩阵归一成 409。版本号自增（`uq_skill_versions_skill_v`）在它下游，
      // 第二个写手根本走不到那里。
      expect(settledShapes(settled, () => 'ok').sort()).toEqual([
        'ConflictError:skill-operation-busy',
        'ok',
      ])
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// ⑤ 事件骨干：committed event 的聚合序号分配（Tier B，普查点名要优先复核）
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T29 —— 同一聚合上两条并发的 committed event', (harness) => {
  test('两条都落库、序号是 1 和 2；READ COMMITTED 与 SERIALIZABLE 两种 opener 都成立', async () => {
    const db = harness.db
    const session = databaseSessionFor(db)
    // cutover 处于 legacy 时 append 不落行、直接返回空 eventRef——那样这条用例测不到任何东西。
    await db
      .update(committedEventFamilyCutovers)
      .set({ mode: 'dispatchable', epoch: 2, changedAt: 1, changeRef: 'rfc359-w8-t29' })
    for (const opener of ['transaction', 'serializable'] as const) {
      for (let round = 0; round < 12; round += 1) {
        // 每轮一个**全新**聚合：heads 表里还没有这一行，两笔并发因此都会走 INSERT 分支
        // ——那是最容易撞主键的一档（已有行时是 UPDATE，PG 会给 40001）。
        const aggregateId = `agg_${ulid()}`
        const append = (tag: string) =>
          session[opener](
            async (tx) =>
              await appendCommittedEvent(tx, {
                producer: 'collaboration',
                family: 'clarify',
                type: 'rfc359.w8.t29.probe',
                aggregate: { kind: 'task', id: aggregateId },
                eventGroupId: `grp_${tag}_${aggregateId}`,
                eventGroupOrdinal: 1,
                operationRef: `op_${tag}_${aggregateId}`,
                occurredAt: 1,
                payload: { tag },
                consumers: [],
              }),
          )
        const settled = await Promise.allSettled([append('a'), append('b')])
        expect(
          settledShapes(settled, (value) => `seq:${String(value.eventRef?.aggregate.seq)}`).sort(),
          `opener=${opener}`,
        ).toEqual(['seq:1', 'seq:2'])
      }
    }
  }, 180_000)
})

// ---------------------------------------------------------------------------
// ⑥ 判据本身：SERIALIZABLE 兜得住什么、兜不住什么
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8-T29 —— SERIALIZABLE 只兜得住「读过要插的那张表」', (harness) => {
  test('同表先读后插 ⇒ 收敛；判据来自另一张表 ⇒ 输家拿到裸唯一冲突', async () => {
    const db = harness.db
    const session = databaseSessionFor(db)

    // (a) 同表：前置读在 users 上，插的也是 users。PG 的 SSI 认得出这对读写依赖 ⇒ 40001 ⇒
    //     `serializable()` 整笔重放 ⇒ 重跑时新快照读得到对方 ⇒ 前置检查命中。
    for (let round = 0; round < 12; round += 1) {
      const username = `t29-same-${ulid().toLowerCase()}`
      const run = () =>
        session.serializable(async (tx) => {
          const hit = await tx.select().from(users).where(eq(users.username, username)).limit(1)
          if (hit.length > 0) return 'already-there'
          await tx.insert(users).values({
            id: `u_${ulid()}`,
            username,
            displayName: username,
            createdAt: 1,
            updatedAt: 1,
          })
          return 'inserted'
        })
      expect(
        settledShapes(await Promise.allSettled([run(), run()]), (value) => value).sort(),
      ).toEqual(['already-there', 'inserted'])
    }

    // (b) 异表：判据读的是 mcps，插的是 users。SSI 在 users 上没有任何谓词锁可挂，后一笔直接
    //     撞唯一索引；SQLite 上前置检查同样对不上（它查的根本不是 users）。这就是
    //     `mcpRuntimeTestPersistence.appendEvent`（读 turns 算序号、插 events）的形状——那里只能靠
    //     `runCatalogTransactionRetryingUniqueViolations` 换一笔事务重来。
    for (let round = 0; round < 12; round += 1) {
      const username = `t29-cross-${ulid().toLowerCase()}`
      const run = () =>
        session.serializable(async (tx) => {
          const unrelated = await tx.select({ id: mcps.id }).from(mcps)
          if (unrelated.length > 99) return 'already-there'
          await tx.insert(users).values({
            id: `u_${ulid()}`,
            username,
            displayName: username,
            createdAt: 1,
            updatedAt: 1,
          })
          return 'inserted'
        })
      const shapes = settledShapes(await Promise.allSettled([run(), run()]), (value) => value)
      expect(shapes.filter((shape) => shape === 'inserted')).toHaveLength(1)
      const loser = shapes.find((shape) => shape !== 'inserted') ?? ''
      // 输家拿到的是**裸驱动错误**（HTTP 边界上就是 500），不是任何域内收场。两个引擎各自的形态：
      // SQLite 是 `SQLITE_CONSTRAINT_UNIQUE`，PostgreSQL 是没有 code 的 `Failed query: insert into …`
      // （23505 藏在 `errno` 里，冒到边界时早已被包成普通 Error）。
      expect(
        /SQLITE_CONSTRAINT|Failed query: insert into/.test(loser),
        `SERIALIZABLE 没能兜住异表判据时，输家应当拿到裸驱动错误；实际是 ${loser}`,
      ).toBe(true)
    }
  }, 120_000)
})
