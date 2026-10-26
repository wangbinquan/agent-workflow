// Locks the second migration stall found by the 4.5GB / 100-client evidence run:
// the daemon's event loop froze **2.8s** during `verifying`, and all 100 status
// clients were dragged to 2.8s with it. The same run at the small seed (two
// orders of magnitude fewer chunks) peaked at 108ms — an O(k²) fingerprint.
//
// The culprit was the copy-receipt grouping inside `assertTargetCoverage`:
//   receiptsByTable.set(tableId, [...current, receipt])
// which rebuilds the array on every receipt, so a table with k chunks costs
// 1+2+…+k element copies. `node_run_events` at the full seed is 10,000,000 rows
// ÷ 1000 rows per chunk = **10,000 chunks** ⇒ ~50 million synchronous copies in
// one uninterrupted loop. bun is single-threaded: that IS the freeze.
//
// 判据为什么是「倍率」而不是「毫秒」（2026-09-17 改，为的是它自己别再假红）
// ------------------------------------------------------------------
// 这条用例的初版断言「1 万个分片 < 150ms」。它在共享 runner 上假红过两次——
// `0e2343757`（2026-09-06，macOS 分片 1/4）与 `b4b1b4cfc`（2026-09-17，macOS 分片 1/6），
// 两次量到的都是 **182ms**。而同一份代码在本机连跑五轮的耗时是 **1.5ms**：
// 150ms 的预算名义上有 100 倍余量，实际却架在一个 **1.5ms 宽的窗口**上——
// runner 上一次 GC 停顿或一次 CPU 抢占（同轮 e2e 腿在刷 `event loop stalled gapMs=19534`）
// 就够越线。两次都落在 182ms 这个量级，也正合「一次同等堆规模的 full GC」的形状。
// 墙钟阈值把「算法复杂度」和「这台机器此刻有多忙」混成了一个数，注定间歇假红；
// 而假红会把所有人训练成「重跑一下就好」，真的 O(k²) 回潮反而被淹掉
// （`docs/audit-backlog.md` 已挂账这一条，本次按它给的正解收掉）。
//
// 现在的判据只依赖**同一台机器上两次测量的相对耗时**：同一形状跑 k 与 8k，
// 线性实现的耗时比约 **8**，二次方约 **64**，判据取两者的几何中点 **21**。
// runner 的快慢对两次测量同等作用，会被比值约掉;两个规模**交替**测，
// 使某一段时间的整体变慢同样落在两边;每个规模取**多轮最小值**，
// 使单次 GC 停顿（只会把某一轮抬高、不可能压低）被排除在判据之外。
import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'

import {
  openPostgresqlLogicalTarget,
  PostgresqlLogicalTargetError,
} from '@/platform/persistence/postgresqlLogicalTarget'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { digestSchemaContract } from '@/platform/persistence/schemaContract'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'

const CONTRACT = logicalSchemaContract
const PLAN = buildPostgresqlSchemaPlan(CONTRACT)
const TABLE = CONTRACT.tables.find((table) => table.id === 'maintenance_state')!
const CHUNK_ROWS = 1_000
/** 与 full 种子里 `node_run_events` 同量级：1000 万行 ÷ 每片 1000 行。 */
const CHUNKS = 10_000
/** 8 倍规模：线性实现的耗时随之 ×8，二次方随之 ×64——判据就架在这两个数中间。 */
const CHUNKS_LARGE = CHUNKS * 8
/** 每个规模重测几轮取最小值。最小值对「停顿」免疫：停顿只抬高某一轮，压不低任何一轮。 */
const REPETITIONS = 5
/**
 * 单轮失控闸：线性实现在 8 万分片上是**十毫秒量级**（本机 11ms），二次方是**十秒量级**
 * （本机约 19s）。4 秒这个数不是预算，是用来在复杂度真的回潮时**当场给出可读的报错**，
 * 而不是让五轮各跑十几秒后撞用例超时。它离线性实现有两个数量级，不参与判定快慢。
 */
const RUNAWAY_MS = 4_000
/** 线性约 8、二次方约 64，取几何中点。两侧各留 2.6～3.0 倍。 */
const MAX_GROWTH = 21

function rows(values: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(values), {
    async values() {
      return values.map((value) => Object.values(value))
    },
  })
}

const RECEIPTS_BY_CHUNK_COUNT = new Map<number, readonly Record<string, unknown>[]>()

/**
 * 收据数组在计时窗口**之外**一次造好并缓存。
 *
 * 不缓存的话，每一轮重测都要现场分配 8 万个对象、随后由 GC 收走——那份分配与回收会被算进
 * 相邻那一轮的耗时里，正是本用例要排除的噪声。
 */
function receiptsFor(chunkCount: number): readonly Record<string, unknown>[] {
  const cached = RECEIPTS_BY_CHUNK_COUNT.get(chunkCount)
  if (cached !== undefined) return cached
  const built = Array.from({ length: chunkCount }, (_unused, index) => ({
    unit_json: JSON.stringify({ table: TABLE.id, chunk: index }),
    rows_written: CHUNK_ROWS,
  }))
  RECEIPTS_BY_CHUNK_COUNT.set(chunkCount, built)
  return built
}

function runtimeFor(
  statements: string[],
  chunkCount: number,
  orphanReceipt = false,
): PostgresqlDatabaseRuntime {
  const receipts = orphanReceipt
    ? [
        {
          unit_json: JSON.stringify({ table: 'outside_roster', chunk: 0 }),
          rows_written: CHUNK_ROWS,
        },
      ]
    : receiptsFor(chunkCount)
  const head = persistenceHead()
  const artifact = persistencePostgresqlCatalogs()[0]!
  let state = {
    sourceGenerationId: 'dbg_source_0001',
    contractDigest: CONTRACT.digest,
    planDigest: PLAN.digest,
    stage: 'prepared',
  }
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe(sql, values = []) {
      statements.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }])
      if (sql.includes('pg_advisory_unlock')) return rows([{ released: true }])
      if (sql.startsWith('SELECT COUNT(*)'))
        return rows([
          {
            count:
              !orphanReceipt && sql.includes(`"${TABLE.providerTables.postgresql}"`)
                ? chunkCount * CHUNK_ROWS
                : 0,
          },
        ])
      if (sql.includes('FROM "agent_workflow_meta"."migration_units"')) return rows(receipts)
      if (sql.includes('FROM "agent_workflow_meta"."migration_records"'))
        return rows([
          { record_json: JSON.stringify(state), record_digest: digestSchemaContract(state) },
        ])
      if (sql.startsWith('INSERT INTO "agent_workflow_meta"."migration_records"')) {
        state = JSON.parse(String(values[1]))
        return rows([])
      }
      if (sql.includes('rfc349-invariant:')) return rows([])
      if (sql.includes('pg_get_serial_sequence') && !sql.includes('setval'))
        return rows([{ sequence_name: 'agent_workflow.fixture_identity_seq' }])
      if (sql.includes('SELECT last_value')) return rows([{ last_value: 1, is_called: false }])
      if (sql.includes('AS max_value')) return rows([{ max_value: null }])
      if (sql.includes('SELECT nextval')) return rows([{ next_value: 1 }])
      if (sql.includes('SELECT 1 FROM information_schema.tables')) return rows([{ present: 1 }])
      if (sql.includes('FROM "agent_workflow_meta"."schema_history"'))
        return rows([
          {
            version: head.contract.version,
            contract_digest: head.contract.contract.digest,
            sqlite_plan_digest: head.sqlite.digest,
            postgresql_plan_digest: head.postgresql.digest,
            applied_at: 1,
            artifact_json: JSON.stringify(head),
          },
        ])
      if (sql.includes("current_setting('server_version_num')"))
        return rows([{ version: artifact.postgresqlMajor * 10000 }])
      if (sql.includes("SELECT 'relation' AS kind"))
        return rows(artifact.catalog.map((entry) => ({ ...entry })))
      return rows([])
    },
    release() {},
  })
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe() {
      throw new Error('finalization must retain its reserved connection')
    },
    async close() {},
  }
  return {
    provider: 'postgresql',
    generationId: 'dbg_linear_0001',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
}

function expectedTables(chunkCount: number) {
  return CONTRACT.tables.map((table) => ({
    table: table.id,
    disposition: table.disposition,
    rowCount: table.id === TABLE.id ? chunkCount * CHUNK_ROWS : 0,
    chunkCount: table.id === TABLE.id ? chunkCount : 0,
  }))
}

/** 只量 `finalizeSchema` 一次调用：建目标、造收据、关闭都在窗口之外。 */
async function measureFinalizeMs(chunkCount: number): Promise<number> {
  const statements: string[] = []
  const target = await openPostgresqlLogicalTarget({
    headContract: CONTRACT,
    runtime: runtimeFor(statements, chunkCount),
    operationId: 'dbm_linear_0001',
    sourceGenerationId: 'dbg_source_0001',
    contract: CONTRACT,
    plan: PLAN,
  })
  try {
    const started = performance.now()
    await target.finalizeSchema(10, expectedTables(chunkCount))
    const elapsed = performance.now() - started
    // A full roster must share one receipt census; rescanning all chunks per table
    // adds a table-count multiplier that the two chunk-size timings cannot detect.
    expect(
      statements.filter((sql) => sql.includes('FROM "agent_workflow_meta"."migration_units"')),
    ).toHaveLength(1)
    return elapsed
  } finally {
    await target.close()
  }
}

describe('RFC-349 live epoch-2 target coverage groups copy receipts in linear time', () => {
  test('grouping cost grows with the chunk count, not with its square', async () => {
    let bestSmall = Number.POSITIVE_INFINITY
    let bestLarge = Number.POSITIVE_INFINITY
    for (let round = 0; round < REPETITIONS; round += 1) {
      // 交替测两个规模：runner 若在某一段时间整体变慢，两边同样吃到，比值把它约掉。
      const small = await measureFinalizeMs(CHUNKS)
      const large = await measureFinalizeMs(CHUNKS_LARGE)
      expect(
        large,
        `分组回到了 O(k²)：${CHUNKS_LARGE} 个分片单轮就花了 ${large.toFixed(0)}ms，` +
          '线性实现在这个规模上是十毫秒量级。' +
          '在真实迁移里这段是 daemon 事件循环被按住的同步时间，且随分片数二次增长',
      ).toBeLessThan(RUNAWAY_MS)
      bestSmall = Math.min(bestSmall, small)
      bestLarge = Math.min(bestLarge, large)
    }

    // 注意二次方版本那十几秒只是**同步阻塞**的下界，而且随分片数二次增长。
    // 真实迁移里它落在 `verifying`，把 100 个客户端的 status 一起拖住。
    const growth = bestLarge / bestSmall
    expect(
      growth,
      `分组回到了 O(k²)：分片数放大 8 倍（${CHUNKS} → ${CHUNKS_LARGE}），` +
        `耗时放大了 ${growth.toFixed(1)} 倍——线性实现应当约 8 倍，二次方约 64 倍。` +
        `本次各取 ${REPETITIONS} 轮最小值：${bestSmall.toFixed(2)}ms → ${bestLarge.toFixed(2)}ms。` +
        '判据是同一台机器上的相对耗时，机器忙不忙会被比值约掉，所以这条红读作复杂度回潮，不是负载',
    ).toBeLessThan(MAX_GROWTH)
  }, 120_000)

  test('a receipt for a table outside the roster is still rejected', async () => {
    const statements: string[] = []
    const target = await openPostgresqlLogicalTarget({
      headContract: CONTRACT,
      runtime: runtimeFor(statements, 1, true),
      operationId: 'dbm_linear_0001',
      sourceGenerationId: 'dbg_source_0001',
      contract: CONTRACT,
      plan: PLAN,
    })
    try {
      await expect(target.finalizeSchema(10, expectedTables(0))).rejects.toBeInstanceOf(
        PostgresqlLogicalTargetError,
      )
    } finally {
      await target.close()
    }
  })
})
