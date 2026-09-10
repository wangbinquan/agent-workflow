// RFC-359 W8 —— 迁移器成对适配器的**双引擎行为对拍**（AC-1 的最后一份见证）。
//
// 这一对为什么不合一
// ---------------------------------------------------------------------------
// 这一对（`PROVIDER_PAIR_CONFORMANCE_LEDGER` 里的 `platform/persistence/Migrator`）是**机制本身
// 不同**的两份实现：一侧把编号 SQL 文件逐条喂给 bun:sqlite（还要重写历史上的有序 JSON 聚合），
// 另一侧在集群级 advisory lock 下按 drizzle 声明准备 schema 并记生成代。硬合一等于把一侧的机制
// 塞进另一侧，AC-1 的修订条款正是为这种对留的例外——**用对拍替代合一**。
//
// 头注刻意**不点名**那两个实现文件：`rfc359-w5-t19d-coverage-parity` 按「测试文件提到该侧模块名」
// 计注意力，一句讲机制的散文就能把两侧 ref 各推高一格、让倒挂加深——而这条测试恰恰是喂两侧的。
//
// 这条对拍锁的是什么
// ---------------------------------------------------------------------------
// 判据必须落在**用户可见契约**那一层，不是实现那一层。迁移器对应用的承诺只有一句：
// **跑完之后，这个库真的实现了应用声明的那份 schema。**
//
// 所以这里不比对两个迁移器的内部动作，而是拿 `buildLogicalSchemaContract()`（从 drizzle 声明
// 派生的表 / 列 / 主键花名册）去**问活库**：每张该有的表都在、每一列都能取回来。
// 两个引擎各跑一遍，判据逐字相同。
//
// 它挡的是一类真实且**不会被别的测试照出来**的漂移：`docs/dev-gotchas.md` 记着
// 「PG 的表 / 索引 / 约束来自 drizzle 声明，不是 SQLite 迁移 SQL——迁移里手写的索引 PG 没有」。
// 同一个道理反过来也成立：drizzle 里加了一列而没写进 SQLite 的迁移 SQL，SQLite 侧就少一列。
// 两种漏法在各自引擎的用例里都不会红（那些用例只碰自己用到的那几张表），但**任何一条读到
// 那张表 / 那一列的生产路径都会在运行时炸**。这条对拍把「声明」与「活库」两侧钉在一起。
//
// 判据用 drizzle 的表对象发查询（`select().from(table).limit(1)`），而不是拼裸 SQL：
// 表名的 schema 限定、标识符引用、方言渲染都交给各自的 dialect——这正是生产路径走的那条。
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import * as schema from '../src/db/schema'
import { migrateSqlite } from '../src/platform/persistence/sqliteMigrator'
import { migratePostgresqlSchema } from '../src/platform/persistence/postgresqlMigrator'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '../src/platform/persistence/postgresqlRuntime'
import { MIGRATIONS } from './migration-freeze'
import { resolvePostgresqlTestUrlEnv } from './helpers/eachProvider'
import { buildLogicalSchemaContract } from '../src/platform/persistence/schemaContract'
import { describeEachProvider } from './helpers/eachProvider'

const CONTRACT = buildLogicalSchemaContract()

/** 本引擎上**应该存在**的表：`ARCHIVE_THEN_OMIT` 的那几张按 D9 只留在 SQLite。 */
function expectedTables(provider: string): readonly (typeof CONTRACT.tables)[number][] {
  return CONTRACT.tables.filter((table) =>
    provider === 'postgresql' ? table.providerTables.postgresql !== undefined : true,
  )
}

function tableObject(schemaSymbol: string): object | undefined {
  const found = (schema as Record<string, unknown>)[schemaSymbol]
  return typeof found === 'object' && found !== null ? found : undefined
}

describeEachProvider('RFC-359 W8 —— 迁移器对拍：活库实现了声明的 schema', (harness) => {
  test('花名册非空且与声明一致（语料自证：判据不是在空集合上恒真）', () => {
    const tables = expectedTables(harness.capabilities.provider)
    expect(tables.length).toBeGreaterThanOrEqual(150)
    expect(CONTRACT.sourceProjection).toBe('sqlite')
  })

  test('每张声明的表都在活库里，且**每一列**都取得回来', async () => {
    const missingSymbols: string[] = []
    const failures: string[] = []
    const tables = expectedTables(harness.capabilities.provider)
    // 录语句：判据必须**真的一表一查**。只看 `failures` 为空的话，循环若被某个 continue
    // 悄悄跳过大半张花名册，测试照样绿——那正是这条对拍最怕的失效方式。
    const recording = harness.recordStatements()
    for (const table of tables) {
      const handle = tableObject(table.schemaSymbol)
      if (handle === undefined) {
        missingSymbols.push(`${table.sourceTable} (${table.schemaSymbol})`)
        continue
      }
      try {
        // `select()` 不带投影 = 选出**全部声明列**：少一列就在这里炸，而不是等到某条生产路径。
        await harness.db
          .select()
          .from(handle as never)
          .limit(1)
      } catch (error) {
        failures.push(`${table.sourceTable}: ${String((error as Error).message).slice(0, 160)}`)
      }
    }
    recording.stop()
    expect(missingSymbols, '声明花名册里的符号在 db/schema 里找不到').toEqual([])
    expect(
      recording.statements.length,
      '实际发出的查询数少于花名册长度 ⇒ 循环跳过了一部分表，判据在空转',
    ).toBeGreaterThanOrEqual(tables.length)
    expect(
      failures,
      `本引擎（${harness.capabilities.provider}）的迁移器没有把这些表 / 列建出来。` +
        '两个方向都可能：drizzle 声明加了列而 SQLite 的迁移 SQL 没跟，或者迁移 SQL 手写了' +
        'PG 侧不存在的东西。各自引擎的用例照绿——它们只碰自己用到的那几张表。',
    ).toEqual([])
  }, 120_000)

  test('守卫自证有牙：一张没被迁移器建出来的表会被这条判据抓到', async () => {
    // 判据本身必须会咬人。用一张**声明里没有、活库里也没有**的表走同一条路：
    // 它必须抛，而不是静静返回空集合——否则上一条测试对「表根本不存在」是瞎的。
    const ghost = sqliteTable('rfc359_w8_ghost_table', { id: text('id').primaryKey() })
    const raised = await harness.db
      .select()
      .from(ghost as never)
      .limit(1)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(raised, '查一张不存在的表必须抛错；不抛的话上一条判据就抓不到缺表').not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 真正**驱动两侧迁移器**的那一半（AC-1 要求的见证形态）
// ---------------------------------------------------------------------------
//
// 上面那批断言问的是「harness 迁完之后活库对不对」——它证明了契约，但没有驱动任一实现，
// 因此不满足 `rfc359-w5-provider-pair-conformance` 的机械判据（`witnessesPair`：对拍必须对
// 两侧实现各有一条**值 import**）。那条判据是对的：不驱动实现的测试不能冒充对拍。
//
// 之前做不到的原因是 PG 侧：`migratePostgresqlSchema` 的 schema 名写死为 `agent_workflow`，
// 在测试里重跑会打到 harness 共用的那个 schema 上、破坏同集群其他文件的库。
// **每文件一库落地后这条限制没了**——本文件可以再建一个自己的一次性库，在上面把 PG 迁移器
// 从零跑一遍。SQLite 侧对应的是一个全新的内存库。
//
// 判据仍落在**用户可见契约**那一层（AC-1 的要求）：跑完之后，这个库真的实现了应用声明的
// 那份 schema——每张声明的表都发一条不带投影的 `select`，少一表或少一列都在这里炸。

/**
 * 「这张表在这个库里有哪些列」——各引擎问自己的目录表。
 *
 * 刻意**不用** drizzle 的表对象：`drizzle-orm/sqlite-core` 的 `getTableConfig` 在
 * PostgreSQL 投影上会抛（`docs/dev-gotchas.md` 有这条），而这里两个 lane 都要能问。
 * 走目录表还更强——它读的是**库里实际存在的东西**，不是应用声明的回声。
 */
interface FreshlyMigrated {
  readonly columnsOf: (table: string) => Promise<readonly string[]>
  readonly dispose: () => Promise<void>
}

/** SQLite 侧：全新内存库 + `migrateSqlite`，列名问 `PRAGMA table_info`。 */
function migrateFreshSqlite(): FreshlyMigrated {
  const sqlite = new Database(':memory:')
  migrateSqlite(sqlite, { migrationsFolder: MIGRATIONS })
  return {
    columnsOf: async (table) =>
      (sqlite.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        (row) => row.name,
      ),
    dispose: async () => {
      sqlite.close()
    },
  }
}

/** PostgreSQL 侧：本文件再建一个一次性库 + `migratePostgresqlSchema`，列名问 `information_schema`。 */
async function migrateFreshPostgresql(): Promise<FreshlyMigrated> {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const current = urlEnv === undefined ? undefined : process.env[urlEnv]
  if (urlEnv === undefined || current === undefined) {
    throw new Error('PostgreSQL harness 已就绪却读不到 URL 环境变量名')
  }
  // harness 已经把 env 指向**本文件自己的库**；同一个集群上再开一个一次性库来跑迁移器。
  const name = `aw_migconf_${String(process.pid)}`
  const admin = new SQL(current)
  try {
    await admin.unsafe(`drop database if exists "${name}"`)
    await admin.unsafe(`create database "${name}"`)
  } finally {
    await admin.close()
  }
  const scratch = new URL(current)
  scratch.pathname = `/${name}`
  const scratchEnv = `AW_MIGCONF_URL_${String(process.pid)}`
  const runtime: PostgresqlDatabaseRuntime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: scratchEnv,
      poolMax: 4,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 10_000,
    },
    generationId: `gen-migconf-${String(process.pid)}`,
    env: { [scratchEnv]: scratch.toString() },
  })
  await migratePostgresqlSchema({ runtime })
  const pool = runtime.providerPool()
  return {
    columnsOf: async (table) => {
      const rows = (await pool.unsafe(
        `select column_name from information_schema.columns ` +
          `where table_schema = 'agent_workflow' and table_name = $1`,
        [table],
      )) as { column_name: string }[]
      return rows.map((row) => row.column_name)
    },
    dispose: async () => {
      await runtime.close?.()
      const cleanup = new SQL(current)
      try {
        await cleanup.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity ` +
            `where datname = '${name}' and pid <> pg_backend_pid()`,
        )
        await cleanup.unsafe(`drop database if exists "${name}"`)
      } finally {
        await cleanup.close()
      }
    },
  }
}

describeEachProvider('RFC-359 W8 —— 迁移器对拍：从零跑一遍本引擎的迁移器', (harness) => {
  test('跑完之后每张声明的表都在，且声明的每一列都真的建了出来', async () => {
    const fresh =
      harness.capabilities.isolation === 'exclusive'
        ? migrateFreshSqlite()
        : await migrateFreshPostgresql()
    try {
      const missingTables: string[] = []
      const missingColumns: string[] = []
      for (const table of expectedTables(harness.capabilities.provider)) {
        const actual = new Set(await fresh.columnsOf(table.sourceTable))
        if (actual.size === 0) {
          missingTables.push(table.sourceTable)
          continue
        }
        for (const column of table.columns) {
          if (!actual.has(column.name)) missingColumns.push(`${table.sourceTable}.${column.name}`)
        }
      }
      expect(
        missingTables,
        `本引擎（${harness.capabilities.provider}）的迁移器从零跑完之后，这些**表**没建出来。` +
          '这一条驱动的是迁移器本身（不是 harness 迁好的库），所以它同时是 AC-1 要求的那份对拍见证。',
      ).toEqual([])
      expect(
        missingColumns,
        '表建出来了但**少列**——drizzle 声明与 SQLite 迁移 SQL 的两侧漂开了。' +
          '这类漏法在各自引擎的用例里都不会红（它们只碰自己用到的那几张表），' +
          '但任何读到那一列的生产路径都会在运行时炸。',
      ).toEqual([])
    } finally {
      await fresh.dispose()
    }
  }, 180_000)
})
