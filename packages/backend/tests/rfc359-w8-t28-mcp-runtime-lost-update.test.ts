// RFC-359 W8-T28 —— MCP playground 持久化在**并发**下的用户可见结果，两个引擎各跑一遍。
//
// 这个文件为什么存在
// ---------------------------------------------------------------------------
// W6-T28 的账本（`tests/architecture/rfc359-w6-t28-read-modify-write.test.ts`）在
// `mcpRuntimeTestPersistence.ts` 上记了 10 处「事务内读—改—写、中间不锁」，是全仓最集中的一个
// 文件。逐处按「两个并发调用能不能让用户看到错的结果」实测下来，结论分两半：
//
//   · **8 处不可达**：这 10 处**全部**位于 `runResourceCatalogTransaction(db, tx => …)` 里，而它
//     等于 `databaseSessionFor(db).serializable(...)`——PG 上是 `SET TRANSACTION ISOLATION LEVEL
//     SERIALIZABLE` + 40001/40P01 整笔重放（`platform/persistence/postgresqlSerializationRetry.ts`，预算 10 次），
//     SQLite 上是 `BEGIN IMMEDIATE` 全库独占。两个并发写手落在**同一行**上时，后一笔在 PG 上拿到
//     40001 并被整笔重跑，重跑时读到的是新快照 —— 丢更新在这里根本发生不了。账本的判据只认
//     `serializable` / `withTaskExecutionSerializable` / `withPostgresqlTaskAggregateTransaction`
//     三个 opener 名，认不出 `runResourceCatalogTransaction` 这一层包装，所以把它们全记成了债。
//     下面 `不可达证据` 两条把这个「保护来自 opener」的事实钉住：把
//     `resourceCatalogTransaction.ts` 的 `.serializable(body)` 换成 `.transaction(body)`
//     （= PG 的 READ COMMITTED），它们在 **PostgreSQL 上立刻红、SQLite 上仍绿**（实测：
//     sessionVersion 2 ≠ 3、双方都收到 `true`）——判据说的竞态是真的，只是这个文件已经躲过了。
//
//   · **2 处可达，且用户真的看得到**：`acceptMessage` 的 `:644` / `:685`。它们不是丢更新——丢更新
//     被 SERIALIZABLE 挡住了——而是**并发的收场形态两个引擎不一样**：两个浏览器标签页（或一次
//     双击）对同一个空闲会话同时发消息时，`acceptMessage` 先按读到的 `turnSeq` 算出新 seq 插入
//     轮次行、再回写会话。两笔事务读到同一个 `turnSeq`，于是都插 `seq = n + 1`，后一笔撞上
//     `uniq_mcp_runtime_test_turns_session_seq`。SQLite 上第二笔根本挤不进来（独占），读到的是
//     已经有在飞轮次的会话，抛干净的 `ConflictError('mcp-test-session-not-ready')` → 409
//     「会话正忙」；**PostgreSQL 上抛的是 23505 唯一键冲突**——不是 40001，重试判据不认，于是原样
//     冒到 HTTP 边界变成 500。用户看到的是「服务器内部错误」而不是「会话正忙，请稍候」。
//     修法按 design §10.1：读之前先 `engineOf(tx).lockAggregateRoot(tx, 会话表, id)`
//     （PG 渲染 `select … for update`，SQLite no-op），后一笔等前一笔提交后重读，走回 409。
//
// 先红后绿的证据（本次落地时实测，`AW_TEST_POSTGRESQL_URL` 指向真库）：
//   修复前 —— sqlite: ConflictError('mcp-test-session-not-ready')；postgresql: 原始
//   `Failed query: insert into "agent_workflow"."mcp_runtime_test_turns" … duplicate key value
//   violates unique constraint "uniq_mcp_runtime_test_turns_session_seq"`。
//   修复后 —— 两个引擎都是 ConflictError('mcp-test-session-not-ready')，库里恰好多出一条轮次行。
//
// 同一类的另外两处（不是读—改—写、不进 T28 账本，但同属「PG 报 500 / SQLite 报 4xx」的功能缺陷，
// 用户裁决「功能问题就做」，一并修掉）
// ---------------------------------------------------------------------------
// 判据都一样：**PG 上唯一键冲突（23505）没有被归一成域错误**，裸驱动错误冲到 HTTP 边界变成 500。
//
//   · `appendEvent` —— `uniq_mcp_runtime_test_events_session_seq`。事件序号是「读出 max、加一、
//     插回」。抛出去这条事件就丢了，抓取判失败、整个测试台会话被标成 unusable；SQLite 上两条都落库。
//   · `create` —— `uniq_mcp_runtime_test_sessions_owner_mcp_live`（同一人同一 MCP 只能有一个活会话）。
//     应当是 409 `mcp-test-session-exists` + 已有会话 id，PG 上却是 500。
//
// 这两处**行锁救不了**：`runResourceCatalogTransaction` 在 PG 上是 SERIALIZABLE，快照在事务第一条
// 语句就冻住，`lockAggregateRoot` 只排队等锁、不刷新快照（实测：给 `appendEvent` 加会话行锁后，
// 后一笔仍算出同一个 `eventSeq` 并撞 23505）。正解是**换一笔事务重来**——新快照读得到对方已提交的
// 行，序号自然往后排、活会话检查自然命中。判据走能力矩阵的 `classifyError(...) ===
// 'unique-violation'`（与 `terminalMaintenancePersistence` / `runtimeSessionLeaseOperations` 同一条）。
// 变异验证：把 `runCatalogTransactionRetryingUniqueViolations` 的重试体拆成一次直调，这两条**只在 PostgreSQL 上**红（3/3 次）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcps,
  users,
} from '@/db/schema'
import { createMcpRuntimeTestPersistence } from '@/modules/resource-catalog/infrastructure/mcpRuntimeTestPersistence'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const HASH = 'a'.repeat(64)

interface SeedOptions {
  /** 会话有没有在飞轮次。`false` = 空闲（可以接新消息）。 */
  readonly inFlight?: boolean
  readonly status?: 'active' | 'ending'
  readonly turnStatus?: 'queued' | 'running'
}

interface Seeded {
  readonly userId: string
  readonly mcpId: string
  readonly sessionId: string
  readonly turnId: string
}

async function seedSession(
  db: ProviderNeutralDatabase,
  options: SeedOptions = {},
): Promise<Seeded> {
  const suffix = ulid().toLowerCase()
  const userId = `u-t28-${suffix}`
  const mcpId = `mcp-t28-${suffix}`
  const sessionId = `ts-t28-${suffix}`
  const turnId = `turn-t28-${suffix}`
  const inFlight = options.inFlight ?? true
  const status = options.status ?? 'active'
  const turnStatus = options.turnStatus ?? 'running'
  await db
    .insert(users)
    .values({ id: userId, username: userId, displayName: 'T28', createdAt: 1, updatedAt: 1 })
  await db.insert(mcps).values({
    id: mcpId,
    name: mcpId,
    type: 'local',
    config: '{}',
    ownerUserId: userId,
    visibility: 'private',
  })
  await db.insert(mcpRuntimeTestSessions).values({
    id: sessionId,
    mcpId,
    ownerUserId: userId,
    clientCreateId: `create-${suffix}`,
    clientCreateDigest: HASH,
    status,
    endReason: status === 'ending' ? 'user' : null,
    mcpConfigHash: HASH,
    runtimeRowId: `runtime-${suffix}`,
    runtimeName: 'opencode',
    runtimeProtocol: 'opencode',
    runtimeSnapshotJson: '{}',
    runtimeBinaryPath: '/mock/opencode',
    runtimeSessionId: `native-${suffix}`,
    nativeSessionState: 'ready',
    inFlightTurnId: inFlight ? turnId : null,
    // status_shape 约束：active 且有在飞轮次时 idle_deadline_at 必须为 NULL，反之必须非 NULL。
    idleDeadlineAt: inFlight || status === 'ending' ? null : 100_000,
    turnSeq: 1,
    sessionVersion: 1,
    scratchRoot: `/tmp/${sessionId}`,
    cleanupState: 'not-started',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(mcpRuntimeTestTurns).values({
    id: turnId,
    sessionId,
    seq: 1,
    clientMessageId: `message-${suffix}`,
    promptText: 'first',
    status: turnStatus,
    hardDeadlineAt: 10_000,
    captureState: 'live',
    startedAt: turnStatus === 'running' ? 1 : null,
    createdAt: 1,
  })
  return { userId, mcpId, sessionId, turnId }
}

/** 只种 user + mcp，不种会话：`create` 用例要从空手起两笔并发。 */
async function seedOwner(db: ProviderNeutralDatabase): Promise<{ userId: string; mcpId: string }> {
  const suffix = ulid().toLowerCase()
  const userId = `u-t28c-${suffix}`
  const mcpId = `mcp-t28c-${suffix}`
  await db
    .insert(users)
    .values({ id: userId, username: userId, displayName: 'T28', createdAt: 1, updatedAt: 1 })
  await db.insert(mcps).values({
    id: mcpId,
    name: mcpId,
    type: 'local',
    config: '{}',
    ownerUserId: userId,
    visibility: 'private',
  })
  return { userId, mcpId }
}

function loadSession(db: ProviderNeutralDatabase, sessionId: string) {
  return db
    .select()
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.id, sessionId))
    .get()
}

/** 拒因的可读形态：领域错误报 `code`，别的（含原始驱动错误）原样带出来，好在断言失败时看清。 */
function rejectionShape(reason: unknown): string {
  return reason instanceof ConflictError
    ? `ConflictError:${reason.code}`
    : `${String((reason as { name?: string })?.name ?? 'unknown')}:${String(
        (reason as { message?: string })?.message ?? reason,
      ).slice(0, 200)}`
}

describeEachProvider('RFC-359 W8-T28 —— MCP playground 并发下的用户可见结果', (harness) => {
  test('两个标签页同时发消息：输的一方拿到 409「会话正忙」，不是驱动层的唯一键错误', async () => {
    const db = harness.db
    const persistence = createMcpRuntimeTestPersistence(db)
    // 单轮就能复现（实测 PG 每轮必红），跑三轮把「刚好被自然串行化」的偶然性也排掉。
    for (let round = 0; round < 3; round += 1) {
      const seeded = await seedSession(db, { inFlight: false })
      const send = (tag: string) =>
        persistence.acceptMessage({
          mcpId: seeded.mcpId,
          sessionId: seeded.sessionId,
          turnId: `${seeded.turnId}-${tag}`,
          clientMessageId: `cm-${tag}`,
          message: `hello ${tag}`,
          // 两个标签页手里都是同一个 sessionVersion——这正是「都以为自己能发」的前提。
          expectedSessionVersion: 1,
          now: 50,
          hardDeadlineAt: 900_000,
          idleDeadlineAt: 900_000,
          maxTurns: 20,
        })
      const settled = await Promise.allSettled([send('a'), send('b')])

      const accepted = settled.filter((entry) => entry.status === 'fulfilled')
      const rejected = settled.filter(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      )
      expect(accepted).toHaveLength(1)
      expect(rejected.map((entry) => rejectionShape(entry.reason))).toEqual([
        'ConflictError:mcp-test-session-not-ready',
      ])

      // 库面同样只前进一格：一条新轮次、turnSeq / sessionVersion 各 +1。
      const session = await loadSession(db, seeded.sessionId)
      expect(session?.turnSeq).toBe(2)
      expect(session?.sessionVersion).toBe(2)
      const turns = await db
        .select({ seq: mcpRuntimeTestTurns.seq })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.sessionId, seeded.sessionId))
        .all()
      expect(turns.map((turn) => turn.seq).sort()).toEqual([1, 2])
    }
  }, 30_000)

  test('两个标签页同时开测试台：输的一方拿到 409「已有会话在跑」，不是驱动层的唯一键错误', async () => {
    const db = harness.db
    const persistence = createMcpRuntimeTestPersistence(db)
    // 40 轮，不是 3：这条在 PG 上是**间歇**的——SSI 的谓词锁多数时候先把两笔认成读写依赖环、给后一笔
    // 40001 并整笔重放（收场正确），少数时候先撞上唯一索引抛 23505（收场是 500）。3 轮次次绿、
    // 40 轮次次红（实测 3/3），这个刻度才拿得住回归。单轮约 12ms，整条仍在一秒级。
    for (let round = 0; round < 40; round += 1) {
      const owner = await seedOwner(db)
      const start = (tag: string) =>
        persistence.create({
          mcpId: owner.mcpId,
          ownerUserId: owner.userId,
          // 两个标签页各自生成自己的幂等键——不是重放，是两次真正的「开新会话」。
          clientCreateId: `cc-${tag}-${String(round)}`,
          requestDigest: HASH,
          sessionId: `ts-${tag}-${ulid().toLowerCase()}`,
          turnId: `turn-${tag}-${ulid().toLowerCase()}`,
          mcpConfigHash: HASH,
          runtimeRowId: `runtime-${tag}`,
          runtimeName: 'opencode',
          runtimeProtocol: 'opencode',
          runtimeSnapshotJson: '{}',
          runtimeBinaryPath: '/mock/opencode',
          runtimeSessionId: null,
          scratchRoot: `/tmp/${tag}`,
          message: `hello ${tag}`,
          clientMessageId: `cm-${tag}`,
          now: 10,
          hardDeadlineAt: 900_000,
          receiptExpiresAt: 900_000,
        })
      const settled = await Promise.allSettled([start('a'), start('b')])

      const accepted = settled.filter((entry) => entry.status === 'fulfilled')
      const rejected = settled.filter(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      )
      expect(accepted).toHaveLength(1)
      // `uniq_mcp_runtime_test_sessions_owner_mcp_live` 是「同一个人对同一个 MCP 只能有一个活会话」
      // 这条产品规则的库面表达；撞上它的正确收场是 409 + 已有会话的 id，不是 500。
      expect(rejected.map((entry) => rejectionShape(entry.reason))).toEqual([
        'ConflictError:mcp-test-session-exists',
      ])
      const live = await db
        .select({ id: mcpRuntimeTestSessions.id })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.mcpId, owner.mcpId))
        .all()
      expect(live).toHaveLength(1)
    }
  }, 30_000)

  test('同一轮次上两条事件同时落库：两条都进得去，事件序号连续不冲突', async () => {
    const db = harness.db
    const persistence = createMcpRuntimeTestPersistence(db)
    for (let round = 0; round < 3; round += 1) {
      const seeded = await seedSession(db)
      const append = (tag: number) =>
        persistence.appendEvent({
          sessionId: seeded.sessionId,
          turnId: seeded.turnId,
          ts: tag,
          kind: 'message',
          payload: `payload-${String(tag)}`,
          runtimeSessionId: null,
          parentSessionId: null,
          source: 'stream',
          externalEventKey: null,
          payloadBytes: 100,
          maxSingleEventBytes: 1_000_000,
          maxSessionRows: 1_000,
          maxSessionBytes: 1_000_000,
        })
      const settled = await Promise.allSettled([append(1), append(2)])

      // 事件序号是「读出 max、加一、插回」——两笔并发在 PG 上算出同一个序号，后一笔撞
      // `uniq_mcp_runtime_test_events_session_seq`。抛出去的话这条事件就丢了，而且抓取被判失败、
      // 整个测试台会话被标成 unusable；SQLite 上两条都好端端地落库。
      expect(
        settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : entry.reason)),
      ).toEqual(['appended', 'appended'])
      const events = await db
        .select({ seq: mcpRuntimeTestEvents.eventSeq })
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, seeded.sessionId))
        .all()
      expect(events.map((event) => event.seq).sort()).toEqual([1, 2])
      // 字节累加器同样不能丢一次：两条各 100 字节。
      const turn = await db
        .select({ bytes: mcpRuntimeTestTurns.captureEventBytes })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, seeded.turnId))
        .get()
      expect(turn?.bytes).toBe(200)
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // 不可达证据：账本上另外 8 处所依赖的那把「锁」不在各站点里，而在
  // `runResourceCatalogTransaction` = `session.serializable` 这一层。下面两条锁住它——
  // 把它降成 `session.transaction`（PG 的 READ COMMITTED），两条都只在 PostgreSQL 上红。
  // -------------------------------------------------------------------------

  test('不可达证据：并发 settleQueuedDurableIntent 只有一方认领成功，版本只 +1', async () => {
    const db = harness.db
    const seeded = await seedSession(db, { status: 'ending', turnStatus: 'queued' })
    const persistence = createMcpRuntimeTestPersistence(db)
    const settle = () =>
      persistence.settleQueuedDurableIntent({
        sessionId: seeded.sessionId,
        turnId: seeded.turnId,
        now: 7,
      })
    const outcomes = await Promise.all([settle(), settle()])

    // 两边都返回 true = 同一个排队轮次被「结算」了两次，上层会据此广播两轮终态。
    expect(outcomes.filter((claimed) => claimed).length).toBe(1)
    const session = await loadSession(db, seeded.sessionId)
    expect(session?.inFlightTurnId).toBeNull()
    expect(session?.sessionVersion).toBe(2)
  }, 30_000)

  test('不可达证据：取消轮次与「MCP 配置已变更」并发时，两次状态推进都留在库里', async () => {
    const db = harness.db
    const seeded = await seedSession(db)
    const persistence = createMcpRuntimeTestPersistence(db)
    await Promise.all([
      persistence.cancel({
        sessionId: seeded.sessionId,
        turnId: seeded.turnId,
        now: 5,
        idleDeadlineAt: 500,
      }),
      persistence.markMcpConfigChanged({ mcpId: seeded.mcpId, now: 5 }),
    ])

    const session = await loadSession(db, seeded.sessionId)
    // 丢更新的形态是：cancel 用它读到的旧行整体覆写，把「配置已变更」这条横幅擦掉，
    // 版本也只前进一格——前端于是拿着一个「看起来没变过」的会话继续发消息。
    expect(session?.continuationBlockedReason).toBe('mcp-config-changed')
    expect(session?.sessionVersion).toBe(3)
  }, 30_000)
})
