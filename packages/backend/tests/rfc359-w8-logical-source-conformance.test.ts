// RFC-359 W8 —— `platform/persistence/LogicalSource` 的**双引擎对拍**。
//
// 这一对是「逻辑备份 / 迁移的读出端」：把一个被冻结的库，按契约逐表、按主键 keyset 分页、
// 编码成 `CanonicalLogicalRow` 交出去。两侧**都是活的生产代码**（判定见本波报告）：
//
//   · SQLite 侧 `sqliteLogicalSource.ts`（267 行）有 4 处生产调用方——
//     `platform/persistence/sqlite/systemProviderBackup.ts:233`（SQLite 部署的逻辑备份）、
//     `platform/persistence/sqlite/systemProviderRestore.ts:119`（备份校验）、
//     `sqliteLogicalSourceWorker.ts:62`（迁移读出的 Worker 线程实体）→ 由
//     `modules/system-operations/infrastructure/databaseMigrationCoordinator.ts:193,232`
//     经 `sqliteLogicalSourceWorkerSupervisor.ts` 驱动。它**不是** `LogicalTarget` 那种一侧死
//     代码的形态：迁移是单向的（SQLite → PostgreSQL），所以 target 侧的 SQLite 实现没人用，
//     source 侧的 SQLite 实现恰恰是迁移的入口。
//   · PostgreSQL 侧 `postgresqlLogicalSource.ts`（283 行）有 2 处：
//     `platform/persistence/databaseOperationalAdapter.ts:128` 与
//     `modules/system-operations/infrastructure/postgresqlProviderBackup.ts:123`
//     （PostgreSQL 部署的逻辑备份）。
//
// # 判定：**读出 / 编码层该合，冻结围栏层不该合**
//
// 两侧端口面逐字同形（`preflight` / `assertUnchanged` / `readChunk` / `close`），`readChunk`
// 的 limit 上下界、cursor 形状校验、`encodeLogicalRow` 出口**是同一份逻辑写了两遍**——本文件
// 的「读出面」用例把它们钉成一条判据，将来合成中立设施时这些断言原样还能跑。
//
// 但**冻结围栏是两台机器**，不是一份实现的两个方言：
//   · SQLite 的 `assertUnchanged` 比对 `PRAGMA data_version` / `page_count` / 文件字节数
//     ——**文件级**代号，任何别的连接写一下（哪怕只是 `PRAGMA wal_checkpoint`）就翻；
//   · PostgreSQL 的 `assertUnchanged` 只复核 `database_generations` 那一行还是不是 active
//     的契约代——**并发写它根本看不见**，因为读出本身跑在一条
//     `REPEATABLE READ READ ONLY` 事务的快照里。
// 这不是一侧漏做：SQLite 没有跨表快照可用，只能靠「文件没动过」反推；PostgreSQL 有快照，
// 于是围栏该守的是「这一代还没被退役」。**两条围栏在本文件里各有一条正向用例，互为对照**，
// 谁将来被改成对方那套，这里就红。
//
// 另一处**能力面**的不对称同样锁在这里：契约里 6 张 `ARCHIVE_THEN_OMIT` 表在 PostgreSQL 的
// 活跃 schema 里**根本不存在**，所以 PG 侧 `preflight` 的表册与 `readChunk` 都把它们排除、
// 读它是 `postgresql-source-schema`；SQLite 侧照读不误（归档产物正是从那里来的）。
//
// # 用户可见面
//
// 判据全部落在「备份 / 迁移读出来的东西长什么样」：同一份逻辑数据在两个引擎上必须编码成
// **同一串 canonical 行**（否则同一个库在两种部署上备份出的清单摘要不同，迁移的逐行核对也
// 对不上），排序必须是同一套**字节序**，越界 / 游标错形必须同样被拒。
//
// 字节序这条不是形式主义。PostgreSQL 侧靠 `postgresqlSchema.ts:79` 给每个 text 列钉的
// `COLLATE "C"` 才与 SQLite 的 BINARY 对齐；实测把 `readChunk` 的 `ORDER BY` 换成一个 locale
// 排序规则（DDL 里的列排序规则不变，于是 `WHERE (key) > (cursor)` 仍按 C 比较），keyset 分页
// **当场漏一行、重一行**——`w8src-punct` 再也没出现过，`w8srcalower` 出现两次。对备份 / 迁移
// 而言那不是「顺序不好看」，是**静默丢数据**。

import { expect, test } from 'bun:test'
// 值 import，不是 `import type`：下面 SQLite 那一支要真开一条写连接去模拟「冻结窗漏了个写手」。
// 因此本文件在 `rfc359-w5-t19f-test-engine-hardcoding.test.ts` 的账本里占一格——**它不是**那条
// 守卫要防的「只验证 SQLite 的判据」（整份判据都在 `describeEachProvider` 里两个引擎各跑一遍），
// 而是双引擎 body 里 SQLite 能力分支的必需品：PostgreSQL 那一支根本没有「文件」这个概念。
// 用别名 / 动态 import 把这条构造藏过那条守卫的文本判据，是它注释里亲口点名的绕法，不干。
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { users } from '@/db/schema'
import type {
  CanonicalLogicalRow,
  CanonicalLogicalValue,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import {
  buildLogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import {
  describeEachProvider,
  resolvePostgresqlTestUrlEnv,
  type ProviderHarness,
} from './helpers/eachProvider'

const CONTRACT = buildLogicalSchemaContract()
const USERS = CONTRACT.tables.find((table) => table.id === 'users')!
const ARCHIVE_ONLY = CONTRACT.tables.find((table) => table.disposition === 'ARCHIVE_THEN_OMIT')!
/** `describeEachProvider` 的 PostgreSQL harness 自己登记的那一代（helpers/eachProvider.ts）。 */
const GENERATION_ID = 'dbg_each_provider_harness'

/**
 * 两侧共有的读出面。快照类型两侧不同（SQLite 带 `dataVersion`/`pageCount`/`fileBytes`，
 * PostgreSQL 带 `generationId`/`schemaDigest`），所以这里只收共有字段——对拍要断言的正是
 * 「共有的那一面必须一致」。
 */
interface LogicalSourceProbe {
  preflight(): Promise<{
    readonly databaseFingerprint: string
    readonly totalRows: number
    readonly tableRows: Readonly<Record<string, number>>
  }>
  assertUnchanged(snapshot: never): Promise<void>
  readChunk(
    table: LogicalTableContract,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<readonly CanonicalLogicalRow[]>
  close(): Promise<void>
}

interface OpenedSource {
  readonly source: LogicalSourceProbe
  /** SQLite 侧是临时文件的绝对路径（外部写手用它模拟「冻结窗漏了个写手」）；PG 侧为 null。 */
  readonly sqlitePath: string | null
  dispose(): Promise<void>
}

/**
 * SQLite 侧：harness 给的是内存库，而 `openSqliteLogicalSource` 按**路径**开只读连接——
 * 把内存库 `serialize()` 成一个临时文件再开，与 `rfc349-sqlite-logical-source.test.ts` 同一姿势。
 */
function openSqliteSource(harness: ProviderHarness): OpenedSource {
  const root = mkdtempSync(join(tmpdir(), 'rfc359-w8-source-'))
  const path = join(root, 'db.sqlite')
  const raw = (harness.db as unknown as { $client: Database }).$client
  writeFileSync(path, raw.serialize())
  const source = openSqliteLogicalSource({ path, contract: CONTRACT })
  return {
    source: source as unknown as LogicalSourceProbe,
    sqlitePath: path,
    async dispose() {
      await source.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * PostgreSQL 侧：`openPostgresqlLogicalSource` 要的是 runtime + 活跃代，harness 只交出
 * provider-中立客户端，所以这里对同一个库另开一条 runtime。harness 登记那一代时用的是占位
 * 摘要 `'digest'`，而逻辑源要求它等于契约摘要——先把它改成真摘要（写围栏
 * `assertActiveGeneration` 只看 `state`，改摘要不影响 harness 自己的写）。
 */
async function openPostgresqlSource(): Promise<OpenedSource> {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  if (urlEnv === undefined) throw new Error('PostgreSQL harness 已就绪却读不到 URL 环境变量名')
  const runtime: PostgresqlDatabaseRuntime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv,
      poolMax: 4,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    generationId: GENERATION_ID,
  })
  try {
    await runtime
      .providerPool()
      .unsafe(
        'UPDATE "agent_workflow_meta"."database_generations" SET contract_digest = $1 WHERE generation_id = $2',
        [CONTRACT.digest, GENERATION_ID],
      )
    const source = await openPostgresqlLogicalSource({
      runtime,
      generationId: GENERATION_ID,
      contract: CONTRACT,
    })
    return {
      source: source as unknown as LogicalSourceProbe,
      sqlitePath: null,
      async dispose() {
        await source.close()
        await runtime.close()
      },
    }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

async function openSource(harness: ProviderHarness): Promise<OpenedSource> {
  return harness.capabilities.isolation === 'exclusive'
    ? openSqliteSource(harness)
    : await openPostgresqlSource()
}

// ---------------------------------------------------------------------------
// 种子：一行「值域丰富」的用户 + 四行只为压排序的用户
// ---------------------------------------------------------------------------

/**
 * id 刻意跨 ASCII 的标点 / 数字 / 大小写分界：`-`(0x2D) < `0`(0x30) < `A`(0x41) < `_`(0x5F)
 * < `a`(0x61)。字节序下顺序唯一，而 PostgreSQL 的库级默认排序规则（en_US 一类）会把标点当
 * 次级权重、把大小写并列——`postgresqlSchema.ts:79` 给 text 列钉的 `COLLATE "C"` 掉了，
 * 这一串就会重排，keyset 分页与清单里的 firstKey/lastKey 随之在两个引擎上分家。
 */
const ORDERED_IDS = ['w8src-punct', 'w8src0digit', 'w8srcAupper', 'w8src_under', 'w8srcalower']

/** 值域丰富的那一行落在字节序最小的 id 上，读第一页就能拿到。 */
const RICH_ID = ORDERED_IDS[0]!
const RICH_EPOCH = 9_007_199_254_740_993n

async function seedUsers(harness: ProviderHarness): Promise<void> {
  await harness.db.insert(users).values(
    ORDERED_IDS.map((id, index) => ({
      id,
      username: `${id}-name`,
      email: id === RICH_ID ? null : `${id}@example.test`,
      displayName: id === RICH_ID ? '双引擎·"引号"·\\反斜杠' : id,
      gitName: '',
      passwordHash: null,
      role: 'user' as const,
      status: 'active' as const,
      // SQLite 上驱动交出 0/1，PostgreSQL 上交出 true/false —— 两侧必须编码成同一个
      // `{type:'boolean'}`，这正是 `encodeLogicalValue` 的 boolean 分支存在的理由。
      forcePasswordChange: id === RICH_ID,
      createdBy: null,
      // 超出 IEEE754 安全整数：SQLite 侧靠 `safeIntegers(true)` 拿到 BigInt，PostgreSQL 侧
      // 的 int8 经 Bun.SQL 回来是字符串。两条路都必须编码成同一串十进制文本。
      createdAt: id === RICH_ID ? (RICH_EPOCH as unknown as number) : 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      lastLoginAt: null,
      schemaVersion: 2,
      accessRevision: 0,
    })),
  )
}

function valuesByColumn(row: CanonicalLogicalRow): Record<string, CanonicalLogicalValue> {
  const out: Record<string, CanonicalLogicalValue> = {}
  USERS.columns.forEach((column, index) => {
    out[column.name] = row.values[index]!
  })
  return out
}

function idsOf(rows: readonly CanonicalLogicalRow[]): string[] {
  return rows
    .map((row) => (row.key[0]?.type === 'text' ? row.key[0].value : ''))
    .filter((id) => ORDERED_IDS.includes(id))
}

// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W8 —— LogicalSource 双引擎对拍', (harness) => {
  test('preflight 的表册与逐表行数落在同一份逻辑数据上（归档表的收录面按能力分叉）', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const snapshot = await opened.source.preflight()
      expect(snapshot.databaseFingerprint.length).toBeGreaterThan(8)
      const seen = await harness.db.select({ id: users.id }).from(users)
      expect(snapshot.tableRows.users).toBe(seen.length)
      expect(snapshot.totalRows).toBeGreaterThanOrEqual(seen.length)
      expect(Object.values(snapshot.tableRows).reduce((sum, count) => sum + count, 0)).toBe(
        snapshot.totalRows,
      )

      // 能力面差异：PostgreSQL 的活跃 schema 里没有 ARCHIVE_THEN_OMIT 表，表册也就不该收录它们。
      const keys = Object.keys(snapshot.tableRows)
      if (harness.capabilities.isolation === 'exclusive') {
        expect(keys).toHaveLength(CONTRACT.tables.length)
        expect(keys).toContain(ARCHIVE_ONLY.id)
      } else {
        expect(keys).toHaveLength(CONTRACT.activeTableCount)
        expect(keys).not.toContain(ARCHIVE_ONLY.id)
      }
    } finally {
      await opened.dispose()
    }
  })

  test('readChunk 把同一行逻辑数据编码成同一串 canonical 值（布尔 / 越界整数 / NULL / 文本）', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const rows = await opened.source.readChunk(USERS, null, 10_000)
      const rich = rows.find((row) => row.key[0]?.type === 'text' && row.key[0].value === RICH_ID)
      expect(rich).toBeDefined()
      expect(rich!.key).toEqual([{ type: 'text', value: RICH_ID }])
      expect(rich!.values).toHaveLength(USERS.columns.length)

      const byColumn = valuesByColumn(rich!)
      expect(byColumn.id).toEqual({ type: 'text', value: RICH_ID })
      expect(byColumn.email).toEqual({ type: 'null' })
      expect(byColumn.password_hash).toEqual({ type: 'null' })
      expect(byColumn.created_by).toEqual({ type: 'null' })
      expect(byColumn.last_login_at).toEqual({ type: 'null' })
      expect(byColumn.display_name).toEqual({
        type: 'text',
        value: '双引擎·"引号"·\\反斜杠',
      })
      expect(byColumn.role).toEqual({ type: 'text', value: 'user' })
      expect(byColumn.force_password_change).toEqual({ type: 'boolean', value: true })
      expect(byColumn.created_at).toEqual({ type: 'integer', value: RICH_EPOCH.toString(10) })
      expect(byColumn.schema_version).toEqual({ type: 'integer', value: '2' })
      expect(byColumn.access_revision).toEqual({ type: 'integer', value: '0' })

      // 同一行里 false 也要落成 boolean（不是 0 / '0'）。
      const plain = rows.find(
        (row) => row.key[0]?.type === 'text' && row.key[0].value === ORDERED_IDS[1],
      )!
      expect(valuesByColumn(plain).force_password_change).toEqual({
        type: 'boolean',
        value: false,
      })
    } finally {
      await opened.dispose()
    }
  })

  test('keyset 分页按字节序推进、终止于空块，两个引擎给出同一串顺序', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const collected: string[] = []
      let cursor: readonly CanonicalLogicalValue[] | null = null
      let guard = 0
      for (;;) {
        const page: readonly CanonicalLogicalRow[] = await opened.source.readChunk(USERS, cursor, 2)
        if (page.length === 0) break
        collected.push(...idsOf(page))
        cursor = page[page.length - 1]!.key
        guard += 1
        if (guard > 200) throw new Error('keyset 分页没有终止')
      }
      expect(collected).toEqual(ORDERED_IDS)
    } finally {
      await opened.dispose()
    }
  })

  test('越界 limit 与错形游标在两个引擎上被同样拒绝', async () => {
    const opened = await openSource(harness)
    try {
      for (const limit of [0, -1, 1.5, 10_001]) {
        await expect(opened.source.readChunk(USERS, null, limit)).rejects.toThrow(
          'logical chunk limit must be between 1 and 10000',
        )
      }
      await expect(
        opened.source.readChunk(
          USERS,
          [
            { type: 'text', value: 'a' },
            { type: 'text', value: 'b' },
          ],
          10,
        ),
      ).rejects.toThrow('logical cursor shape does not match users')
    } finally {
      await opened.dispose()
    }
  })

  test('归档表的读出面按能力分叉：SQLite 照读，PostgreSQL 明拒', async () => {
    const opened = await openSource(harness)
    try {
      if (harness.capabilities.isolation === 'exclusive') {
        expect(await opened.source.readChunk(ARCHIVE_ONLY, null, 10)).toEqual([])
      } else {
        await expect(opened.source.readChunk(ARCHIVE_ONLY, null, 10)).rejects.toThrow(
          `does not contain archive-only table ${ARCHIVE_ONLY.id}`,
        )
      }
    } finally {
      await opened.dispose()
    }
  })

  test('冻结围栏：干净的库两侧都放行，close() 幂等', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const snapshot = await opened.source.preflight()
      await opened.source.assertUnchanged(snapshot as never)
      await opened.source.close()
      await opened.source.close()
    } finally {
      await opened.dispose()
    }
  })

  test('关闭之后每一个读出口都以本源的类型化错误拒绝', async () => {
    const opened = await openSource(harness)
    const snapshot = await opened.source.preflight()
    await opened.source.close()
    try {
      await expect(opened.source.preflight()).rejects.toThrow('logical source is closed')
      await expect(opened.source.readChunk(USERS, null, 10)).rejects.toThrow(
        'logical source is closed',
      )
      await expect(opened.source.assertUnchanged(snapshot as never)).rejects.toThrow(
        'logical source is closed',
      )
    } finally {
      await opened.dispose()
    }
  })

  test('preflight 幂等，且快照跨一次结构化克隆仍能用于围栏复核', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const first = await opened.source.preflight()
      const second = await opened.source.preflight()
      expect(second).toEqual(first)
      // 迁移读出侧的快照会经 Worker postMessage 往返（`sqliteLogicalSourceWorkerSupervisor.ts`），
      // 到达调用方时已经不是同一个对象引用。围栏复核必须按**值**判定。
      await opened.source.assertUnchanged(structuredClone(first) as never)

      // 但按值不等于放行：描述的不是这个源的快照必须照样被拒。两侧的快照字段不同
      // （SQLite 是文件代号，PostgreSQL 是行数普查），各挑一个本源真的会比对的字段改坏。
      const tampered =
        harness.capabilities.isolation === 'exclusive'
          ? {
              ...first,
              pageCount: (first as unknown as { pageCount: number }).pageCount + 1,
            }
          : { ...first, totalRows: first.totalRows + 1 }
      await expect(opened.source.assertUnchanged(tampered as never)).rejects.toThrow(Error)
    } finally {
      await opened.dispose()
    }
  })

  test('冻结围栏守的东西两侧本质不同：文件代号 vs 活跃生成代', async () => {
    await seedUsers(harness)
    const opened = await openSource(harness)
    try {
      const snapshot = await opened.source.preflight()
      const before = await opened.source.readChunk(USERS, null, 10_000)

      if (harness.capabilities.isolation === 'exclusive') {
        // SQLite：围栏是**文件级**代号。冻结窗里漏进任何一个写手都必须被点名。
        const writer = new Database(opened.sqlitePath!)
        writer.exec(`UPDATE users SET display_name = 'moved' WHERE id = '${ORDERED_IDS[1]}'`)
        writer.close()
        await expect(opened.source.assertUnchanged(snapshot as never)).rejects.toThrow(
          'changed after the migration freeze',
        )
      } else {
        // PostgreSQL：读出跑在一条 REPEATABLE READ 快照里，并发写**看不见**也不该翻围栏；
        // 围栏守的是「这一代还是不是 active 的契约代」。
        await harness.db
          .update(users)
          .set({ displayName: 'moved' })
          .where(eq(users.id, ORDERED_IDS[1]!))
        await opened.source.assertUnchanged(snapshot as never)
        expect(await opened.source.readChunk(USERS, null, 10_000)).toEqual(before)

        const runtime = createPostgresqlDatabaseRuntime({
          config: {
            provider: 'postgresql',
            urlEnv: resolvePostgresqlTestUrlEnv(process.env)!,
            poolMax: 2,
            connectTimeoutMs: 10_000,
            statementTimeoutMs: 60_000,
            idleTimeoutMs: 30_000,
          },
          generationId: GENERATION_ID,
        })
        try {
          await runtime
            .providerPool()
            .unsafe(
              `UPDATE "agent_workflow_meta"."database_generations" SET state = 'retired' WHERE generation_id = $1`,
              [GENERATION_ID],
            )
          await expect(opened.source.assertUnchanged(snapshot as never)).rejects.toThrow(
            'not the active contract generation',
          )
        } finally {
          await runtime
            .providerPool()
            .unsafe(
              `UPDATE "agent_workflow_meta"."database_generations" SET state = 'active' WHERE generation_id = $1`,
              [GENERATION_ID],
            )
          await runtime.close()
        }
      }
    } finally {
      await opened.dispose()
    }
  })
})
