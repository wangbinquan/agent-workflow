// RFC-359 W8 —— 保留期清理（retention sweep）的双引擎对拍。
//
// 又一对被「按文件名配对」的账本漏掉的成对适配器
// ==============================================
//   · SQLite     —— `platform/persistence/sqlite/systemMaintenanceRetention.ts`
//                   的 `runRetentionSweepSlice`
//   · PostgreSQL —— `platform/persistence/postgresqlMaintenanceRetention.ts`
//                   的 `runPostgresqlRetentionSweepSlice`
//
// 两侧同一份判据、同一个游标契约，但**是两台机器**：SQLite 用
// `DELETE … WHERE rowid IN (SELECT … ORDER BY id LIMIT n)`，PostgreSQL 用
// `WITH candidates AS (…) DELETE … USING candidates`。PG 那份的头注释写着
// 「predicates and durable cursor mirror the SQLite oracle」——**mirror 是靠人眼保证的**，
// 在此之前没有任何一条测试同时跑过两侧。
//
// 这一族的既有覆盖同样是单引擎倒挂：`rfc311-retention-sweep.test.ts` /
// `rfc338-maintenance-slices.test.ts` 只跑 SQLite，`rfc349-system-maintenance-provider.test.ts`
// 只跑 PostgreSQL。**没有任何一条断言要求两侧删同一批。**
//
// 这里补的就是那条判据，写在**用户可见后果**那一层：
// 「同样的库、同样的保留期配置、同样的时刻 —— 两个引擎删掉同一批行、留下同一批行」。
// 留下哪些行是用户直接能看见的：任务详情页的事件流、澄清会话的历史、MCP 联调回放、
// webhook 触发记录。删多了是数据丢失，删少了是无界增长。
//
// 判据形状：`describeEachProvider` 把同一段 body 在 SQLite 内存库与真 PostgreSQL 上各跑一遍。
// body **拿不到 provider 名**，只能按 `capabilities.isolation` 选该引擎的那份实现——
// 于是「两侧期望值必须逐字相同」这件事由 harness 本身强制，写不出「PG 上少删一行也算过」。
//
// 已知的**正当**差异：SQLite 侧另有一个 `runRetentionSweep`（把 slice 循环到 done 的
// 每小时整趟入口），PostgreSQL 侧没有对应物——PG 的整趟循环由
// `platform/background/maintenanceWorker.ts` 的分片调度器驱动。整趟入口不同不影响
// **每一片删什么**，本文件锁的是后者。

import { expect, test } from 'bun:test'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  intentSessions,
  intentTurnEvents,
  intentTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  mcps,
  memoryDistillEvents,
  memoryDistillJobs,
  tasks,
  users,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { runPostgresqlRetentionSweepSlice } from '@/platform/persistence/postgresqlMaintenanceRetention'
import { runRetentionSweepSlice } from '@/platform/persistence/sqlite/systemMaintenanceRetention'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 100_000_000
const DAY_MS = 86_400_000
/** 保留 1 天 ⇒ 截止时刻 = NOW - 1 天。比它旧的才有资格被删。 */
const CUTOFF = NOW - DAY_MS
const OLD = CUTOFF - 1_000
const RECENT = CUTOFF + 1_000

const CONFIG = { eventStreamRetentionDays: 1, webhookTriggerFiresRetentionDays: 1 }

/**
 * 一片清理的**共同**返回形状。
 *
 * 计数器名字在这里被显式钉成一个闭集——**这本身就是对拍的第一道，且发生在编译期**：
 * 两侧各自的结果类型（SQLite 的 `RetentionSweepResult` 可变、PostgreSQL 的
 * `PostgresqlRetentionSweepResult` 只读）都必须能赋值进来，哪天任一侧改名 / 增删一个
 * 计数器而另一侧没跟上，这个文件就编不过，不用等运行时。
 */
type RetentionCounterName =
  | 'distillEvents'
  | 'intentTurnEvents'
  | 'mcpRuntimeTestEvents'
  | 'webhookTriggerFires'
  | 'userAccessAudit'

type RetentionSlice = Readonly<{
  done: boolean
  cursor: unknown
  counters: Readonly<Record<RetentionCounterName, number>>
}>

/** 两个引擎各自的那份实现。签名与游标契约相同，SQL 是两台机器。 */
function sweepSlice(
  harness: ProviderHarness,
): (cursor: unknown, batchSize: number) => Promise<RetentionSlice> {
  const db = harness.db
  // body 看不见 provider 名，只看得见能力：'exclusive' 是 SQLite 的独占事务形态。
  const isSqlite = harness.capabilities.isolation === 'exclusive'
  return async (cursor, batchSize) =>
    isSqlite
      ? await runRetentionSweepSlice(db as unknown as DbClient, CONFIG, cursor, NOW, batchSize)
      : await runPostgresqlRetentionSweepSlice(
          db as unknown as PostgresqlDatabaseClient,
          CONFIG,
          cursor,
          NOW,
          batchSize,
        )
}

/** 循环到 done，累加计数并记下走过的相位序列。 */
async function sweepToCompletion(
  harness: ProviderHarness,
  batchSize: number,
): Promise<{ totals: Record<string, number>; phases: string[] }> {
  const slice = sweepSlice(harness)
  const totals: Record<string, number> = {}
  const phases: string[] = []
  let cursor: unknown = null
  for (let guard = 0; guard < 100; guard += 1) {
    const result = await slice(cursor, batchSize)
    for (const [key, value] of Object.entries(result.counters)) {
      totals[key] = (totals[key] ?? 0) + value
    }
    phases.push(String((result.cursor as { phase: string }).phase))
    if (result.done) return { totals, phases }
    cursor = result.cursor
  }
  throw new Error('retention sweep did not converge')
}

/**
 * 四个相位各种一批「该删的」与「该留的」。
 *
 * 「该留」有两种理由，两侧都必须同样尊重：
 *   ① 行本身还没过期（`RECENT`）；
 *   ② 行过期了，但它的**宿主还没进终态**——蒸馏 job 还在跑 / 澄清会话还没归档 /
 *      MCP 联调会话还活着 / webhook 指向的任务还在执行。宿主行上的计数与状态列不会跟着消失，
 *      提前删掉事件会让面板呈现成「complete · 42 events」而内容空白（RFC-311 实现门 P2-11）。
 */
async function seed(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'u1',
    username: 'u1',
    displayName: 'u1',
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(mcps).values({ id: 'mcp-1', name: 'mcp-1', type: 'local' })
  await db.insert(webhookEndpoints).values({
    id: 'ep-1',
    name: 'ep',
    provider: 'gitlab',
    urlToken: 'tok',
    secretEnc: 'x',
  })
  await db.insert(webhookTriggers).values({
    id: 'trig-1',
    name: 'trig',
    endpointId: 'ep-1',
    ownerUserId: 'u1',
    repoScope: '{}',
    eventTypes: '[]',
    launchKind: 'workflow',
    launchRefId: 'wf-1',
    launchPayload: '{}',
  })

  // ── 相位 1：蒸馏事件 —— 宿主终态才删 ────────────────────────────────────────
  await db.insert(memoryDistillJobs).values([
    {
      id: 'job-done',
      debounceKey: 'dk-done',
      sourceKind: 'review',
      sourceEventId: 'ev-1',
      scopeResolvedJson: '{}',
      status: 'done',
      nextRunAt: 1,
      createdAt: 1,
    },
    {
      id: 'job-running',
      debounceKey: 'dk-running',
      sourceKind: 'review',
      sourceEventId: 'ev-2',
      scopeResolvedJson: '{}',
      status: 'running',
      nextRunAt: 1,
      createdAt: 1,
    },
  ])
  await db.insert(memoryDistillEvents).values([
    // 删：过期 + 宿主已 done（两条，好让分批边界也被走到）
    {
      distillJobId: 'job-done',
      attemptIndex: 0,
      sessionId: 's',
      ts: OLD,
      kind: 'a',
      payload: '{}',
    },
    {
      distillJobId: 'job-done',
      attemptIndex: 0,
      sessionId: 's',
      ts: OLD,
      kind: 'b',
      payload: '{}',
    },
    // 留：宿主已 done 但还没过期
    {
      distillJobId: 'job-done',
      attemptIndex: 0,
      sessionId: 's',
      ts: RECENT,
      kind: 'keep-recent',
      payload: '{}',
    },
    // 留：过期了，但宿主还在跑
    {
      distillJobId: 'job-running',
      attemptIndex: 0,
      sessionId: 's',
      ts: OLD,
      kind: 'keep-live-host',
      payload: '{}',
    },
  ])

  // ── 相位 2：澄清会话事件 —— 会话 archived 才删 ──────────────────────────────
  await db.insert(intentSessions).values([
    { id: 'sess-archived', ownerUserId: 'u1', status: 'archived', createdAt: 1, updatedAt: 1 },
    { id: 'sess-active', ownerUserId: 'u1', status: 'active', createdAt: 1, updatedAt: 1 },
  ])
  await db.insert(intentTurns).values([
    {
      id: 'turn-archived',
      sessionId: 'sess-archived',
      seq: 1,
      role: 'agent',
      kind: 'message',
      createdAt: 1,
    },
    {
      id: 'turn-active',
      sessionId: 'sess-active',
      seq: 1,
      role: 'agent',
      kind: 'message',
      createdAt: 1,
    },
  ])
  await db.insert(intentTurnEvents).values([
    { turnId: 'turn-archived', eventSeq: 1, ts: OLD, kind: 'a', payload: '{}', source: 'stream' },
    {
      turnId: 'turn-archived',
      eventSeq: 2,
      ts: RECENT,
      kind: 'keep-recent',
      payload: '{}',
      source: 'stream',
    },
    {
      turnId: 'turn-active',
      eventSeq: 1,
      ts: OLD,
      kind: 'keep-live-host',
      payload: '{}',
      source: 'stream',
    },
  ])

  // ── 相位 3：MCP 联调事件 —— 会话 ended 才删 ────────────────────────────────
  await db.insert(mcpRuntimeTestSessions).values([
    {
      id: 'mrts-ended',
      mcpId: 'mcp-1',
      ownerUserId: 'u1',
      clientCreateId: 'cc-ended',
      clientCreateDigest: 'a'.repeat(64),
      status: 'ended',
      endReason: 'user',
      endedAt: 1,
      mcpConfigHash: 'b'.repeat(64),
      runtimeRowId: 'rt-1',
      runtimeName: 'rt',
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: '/bin/true',
      scratchRoot: '/tmp/x',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'mrts-active',
      mcpId: 'mcp-1',
      ownerUserId: 'u1',
      clientCreateId: 'cc-active',
      clientCreateDigest: 'c'.repeat(64),
      status: 'active',
      idleDeadlineAt: 1,
      nativeSessionState: 'ready',
      mcpConfigHash: 'd'.repeat(64),
      runtimeRowId: 'rt-2',
      runtimeName: 'rt',
      runtimeProtocol: 'opencode',
      runtimeSnapshotJson: '{}',
      runtimeBinaryPath: '/bin/true',
      scratchRoot: '/tmp/y',
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  await db.insert(mcpRuntimeTestEvents).values([
    {
      testSessionId: 'mrts-ended',
      firstSeenTurnId: 't',
      eventSeq: 1,
      ts: OLD,
      kind: 'a',
      payload: '{}',
      source: 'stream',
    },
    {
      testSessionId: 'mrts-ended',
      firstSeenTurnId: 't',
      eventSeq: 2,
      ts: RECENT,
      kind: 'keep-recent',
      payload: '{}',
      source: 'stream',
    },
    {
      testSessionId: 'mrts-active',
      firstSeenTurnId: 't',
      eventSeq: 1,
      ts: OLD,
      kind: 'keep-live-host',
      payload: '{}',
      source: 'stream',
    },
  ])

  // ── 相位 4：webhook 触发记录 —— 指向的任务不在非终态才删 ────────────────────
  const task = (id: string, status: 'done' | 'running') => ({
    id,
    name: id,
    workflowId: 'wf-1',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/wt/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 1,
    finishedAt: null,
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: 1 },
    ]),
  })
  await db.insert(tasks).values([task('task-done', 'done'), task('task-running', 'running')])
  await db.insert(webhookTriggerFires).values([
    // 删：过期 + 任务已终态。id 是 text ULID 位（`ORDER BY id` 按字典序），零填充保证稳定。
    {
      id: 'fire-01',
      deliveryId: 'd1',
      triggerId: 'trig-1',
      streamKey: 'k',
      outcome: 'launched',
      firedAt: OLD,
      taskId: 'task-done',
    },
    // 删：过期 + 压根没有关联任务（`task_id` 可空且无外键）。
    {
      id: 'fire-02',
      deliveryId: 'd2',
      triggerId: 'trig-1',
      streamKey: 'k',
      outcome: 'launched',
      firedAt: OLD,
      taskId: null,
    },
    // 留：任务还在跑。
    {
      id: 'fire-03',
      deliveryId: 'd3',
      triggerId: 'trig-1',
      streamKey: 'k',
      outcome: 'launched',
      firedAt: OLD,
      taskId: 'task-running',
    },
    // 留：还没过期。
    {
      id: 'fire-04',
      deliveryId: 'd4',
      triggerId: 'trig-1',
      streamKey: 'k',
      outcome: 'launched',
      firedAt: RECENT,
      taskId: 'task-done',
    },
  ])
}

/** 清理后仍在库里的行（按用户能认出来的标识），两个引擎必须逐字相同。 */
async function survivors(db: ProviderNeutralDatabase): Promise<Record<string, string[]>> {
  const sorted = (values: string[]): string[] => [...values].sort()
  return {
    distillEvents: sorted(
      (await db.select({ kind: memoryDistillEvents.kind }).from(memoryDistillEvents)).map(
        (row) => row.kind,
      ),
    ),
    intentTurnEvents: sorted(
      (await db.select({ kind: intentTurnEvents.kind }).from(intentTurnEvents)).map(
        (row) => row.kind,
      ),
    ),
    mcpRuntimeTestEvents: sorted(
      (await db.select({ kind: mcpRuntimeTestEvents.kind }).from(mcpRuntimeTestEvents)).map(
        (row) => row.kind,
      ),
    ),
    webhookTriggerFires: sorted(
      (await db.select({ id: webhookTriggerFires.id }).from(webhookTriggerFires)).map(
        (row) => row.id,
      ),
    ),
  }
}

describeEachProvider('RFC-359 W8 —— 保留期清理在两个引擎上删同一批', (harness) => {
  test('① 整趟清理：两侧删掉同一批、留下同一批', async () => {
    await seed(harness.db)

    const { totals } = await sweepToCompletion(harness, 50)

    expect(totals).toEqual({
      distillEvents: 2,
      intentTurnEvents: 1,
      mcpRuntimeTestEvents: 1,
      // user_access_audit 有 append-only 触发器，落地裁决是不清理它；两侧都恒 0。
      userAccessAudit: 0,
      webhookTriggerFires: 2,
    })

    expect(await survivors(harness.db)).toEqual({
      // 「还没过期」与「宿主还活着」两种保留理由，两侧都必须同样尊重。
      distillEvents: ['keep-live-host', 'keep-recent'],
      intentTurnEvents: ['keep-live-host', 'keep-recent'],
      mcpRuntimeTestEvents: ['keep-live-host', 'keep-recent'],
      webhookTriggerFires: ['fire-03', 'fire-04'],
    })
  })

  test('② 分批：批量上限逼出多片时，两侧走同一条相位序列、总账仍相同', async () => {
    await seed(harness.db)

    // batchSize=1 ⇒ 每个相位都要多跑几片才能翻页，游标契约被真正走到。
    const { totals, phases } = await sweepToCompletion(harness, 1)

    expect(phases).toEqual([
      // 蒸馏：删 2 条 ⇒ 满批、满批、空批（空批才翻相位）
      'distill-events',
      'distill-events',
      'intent-turn-events',
      // 澄清：删 1 条
      'intent-turn-events',
      'mcp-runtime-test-events',
      // MCP：删 1 条
      'mcp-runtime-test-events',
      'webhook-trigger-fires',
      // webhook：删 2 条
      'webhook-trigger-fires',
      'webhook-trigger-fires',
      'done',
    ])
    expect(totals).toEqual({
      distillEvents: 2,
      intentTurnEvents: 1,
      mcpRuntimeTestEvents: 1,
      userAccessAudit: 0,
      webhookTriggerFires: 2,
    })
    expect(await survivors(harness.db)).toEqual({
      distillEvents: ['keep-live-host', 'keep-recent'],
      intentTurnEvents: ['keep-live-host', 'keep-recent'],
      mcpRuntimeTestEvents: ['keep-live-host', 'keep-recent'],
      webhookTriggerFires: ['fire-03', 'fire-04'],
    })
  })

  test('③ 保留期关成 0 = 该相位整段跳过，两侧同形', async () => {
    await seed(harness.db)
    const db = harness.db
    const isSqlite = harness.capabilities.isolation === 'exclusive'
    const offForEvents = { eventStreamRetentionDays: 0, webhookTriggerFiresRetentionDays: 1 }
    const slice = async (cursor: unknown) =>
      isSqlite
        ? await runRetentionSweepSlice(db as unknown as DbClient, offForEvents, cursor, NOW, 50)
        : await runPostgresqlRetentionSweepSlice(
            db as unknown as PostgresqlDatabaseClient,
            offForEvents,
            cursor,
            NOW,
            50,
          )

    // 事件三胞胎被关掉 ⇒ 第一片直接落在 webhook 相位，三张事件表一行不动。
    const first = await slice(null)
    expect(first.counters).toEqual({
      distillEvents: 0,
      intentTurnEvents: 0,
      mcpRuntimeTestEvents: 0,
      userAccessAudit: 0,
      webhookTriggerFires: 2,
    })
    expect(await slice(first.cursor)).toMatchObject({ done: true })

    const remaining = await survivors(harness.db)
    expect(remaining.distillEvents).toHaveLength(4)
    expect(remaining.intentTurnEvents).toHaveLength(3)
    expect(remaining.mcpRuntimeTestEvents).toHaveLength(3)
    expect(remaining.webhookTriggerFires).toEqual(['fire-03', 'fire-04'])
  })

  test('④ 坏游标两侧给同一个错', async () => {
    const run = async (cursor: unknown): Promise<unknown> =>
      await sweepSlice(harness)(cursor, 50).catch((error: unknown) => error)

    for (const bad of [
      { version: 2, phase: 'distill-events', eventCutoff: 1, webhookCutoff: 1 },
      { version: 1, phase: 'nope', eventCutoff: 1, webhookCutoff: 1 },
      { version: 1, phase: 'distill-events', eventCutoff: 1.5, webhookCutoff: 1 },
    ]) {
      expect((await run(bad)) as Error).toMatchObject({
        message: 'maintenance-retention-cursor-invalid',
      })
    }
    // 相位与配置对不上（事件相位 + 事件保留期关闭）：另一条明确的错，不是静默跳过。
    expect(
      (await run({
        version: 1,
        phase: 'webhook-trigger-fires',
        eventCutoff: 1,
        webhookCutoff: null,
      })) as Error,
    ).toMatchObject({ message: 'maintenance-retention-cursor-phase-invalid' })
  })

  test('⑤ 批量上限非法两侧同样拒绝', async () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        (await sweepSlice(harness)(null, bad).catch((error: unknown) => error)) as Error,
      ).toMatchObject({ message: 'maintenance-retention-batch-invalid' })
    }
  })
})
