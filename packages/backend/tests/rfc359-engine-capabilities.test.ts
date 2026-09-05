// RFC-359 W2-T11b —— 能力矩阵的闭集纪律：**每一项在两个引擎上各有一次真实执行**。
//
// 这是矩阵存在的意义：一份实现按能力提需求，边界按引擎渲染。渲染对不对不能靠读代码，
// 要在真引擎上执行——本轮对账里 int8 回字符串、SQLSTATE 在 errno 不在 code，都是脚本化
// runtime 看不见、只有真引擎才暴露的形态。
//
// SQLite 侧用内存库；PostgreSQL 侧按环境门控（无 URL 时 skip，与 rfc357-postgresql-page 同一约定；
// RFC-359 W5-T21 落地后由全量 PG lane 保证「有库时必跑」）。

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

import { createInMemoryDb, type DbClient } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { tasks } from '@/db/schema'
import {
  createPostgresqlCapabilities,
  createSqliteCapabilities,
  type EngineCapabilities,
} from '@/platform/persistence/capabilities'
import {
  createPostgresqlDatabaseSession,
  createSqliteDatabaseSession,
} from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { MIGRATIONS } from './migration-freeze'

const render = (q: ReturnType<typeof sql>): string => new SQLiteSyncDialect().sqlToQuery(q).sql

// ─── 引擎无关的部分：两个 provider 必须给出完全相同的答案 ────────────────────────────

describe('RFC-359 能力矩阵 —— 引擎无关项在两侧逐字一致', () => {
  const both: readonly EngineCapabilities[] = [
    createSqliteCapabilities(),
    createPostgresqlCapabilities(),
  ]

  test('likeEscape：转义符、% 与 _ 都被转义，且顺序正确（先转义转义符本身）', () => {
    for (const cap of both) {
      const out = cap.likeEscape('a\\b%c_d')
      expect(out.escape).toBe('\\')
      expect(out.pattern).toBe('%a\\\\b\\%c\\_d%')
    }
  })

  test('numericFromRawRow：数字与数字串归一，非数值抛错而不是静默 NaN', () => {
    for (const cap of both) {
      expect(cap.numericFromRawRow(42, 'x')).toBe(42)
      expect(cap.numericFromRawRow('1788278410000', 'x')).toBe(1788278410000)
      expect(() => cap.numericFromRawRow('abc', 'started_at')).toThrow('started_at')
    }
  })
})

// ─── SQLite：真实执行 ───────────────────────────────────────────────────────────

describe('RFC-359 能力矩阵 —— SQLite 真实执行', () => {
  const cap = createSqliteCapabilities()
  function scratch(): DbClient {
    const db = createInMemoryDb(MIGRATIONS)
    db.run(sql.raw('create table cap_scratch(id integer primary key, name text unique, v integer)'))
    return db
  }

  test('isolation 与参数上限', () => {
    expect(cap.provider).toBe('sqlite')
    expect(cap.isolation).toBe('exclusive')
    expect(cap.maxBindParameters).toBe(32_766)
  })

  test('lockAggregateRoot 与 advisoryLock 是 no-op，claimLockClause 为空', async () => {
    const db = scratch()
    const session = createSqliteDatabaseSession(db)
    await session.transaction(async (tx) => {
      await cap.lockAggregateRoot(tx, tasks, tasks.id, 'nope')
      await cap.advisoryLock(tx, 'k')
    })
    expect(render(cap.claimLockClause())).toBe('')
  })

  test('NULL 排序：ASC 默认 NULL 最前、DESC 默认 NULL 最后（矩阵不加修饰即正确）', () => {
    const db = scratch()
    for (const v of [2, null, 1]) db.run(sql`insert into cap_scratch(v) values (${v})`)
    const col = sql.raw('v')
    const asc = db.all<{ v: number | null }>(
      sql`select v from cap_scratch order by ${cap.ascNullsFirst(col)}`,
    )
    const desc = db.all<{ v: number | null }>(
      sql`select v from cap_scratch order by ${cap.descNullsLast(col)}`,
    )
    expect(asc.map((r) => r.v)).toEqual([null, 1, 2])
    expect(desc.map((r) => r.v)).toEqual([2, 1, null])
  })

  test('likeCaseInsensitive：ASCII 不敏感，且显式 ESCAPE 让 % _ \\ 按字面匹配', () => {
    const db = scratch()
    for (const n of ['Hello World', 'C:\\build\\out', 'C:build', '100%']) {
      db.run(sql`insert into cap_scratch(name) values (${n})`)
    }
    const find = (term: string): string[] => {
      const { pattern, escape } = cap.likeEscape(term)
      return db
        .all<{
          name: string
        }>(
          sql`select name from cap_scratch where ${cap.likeCaseInsensitive(sql.raw('name'), pattern, escape)}`,
        )
        .map((r) => r.name)
    }
    expect(find('hello')).toEqual(['Hello World'])
    expect(find('C:\\build')).toEqual(['C:\\build\\out'])
    expect(find('100%')).toEqual(['100%'])
  })

  test('indexHint 渲染 INDEXED BY；reclaimScrubbedStorage 真跑 secure_delete + checkpoint + VACUUM', async () => {
    const db = scratch()
    expect(render(cap.indexHint('idx_cap_scratch'))).toBe('INDEXED BY "idx_cap_scratch"')
    db.run(sql.raw('create index idx_cap_scratch on cap_scratch(v)'))
    expect(
      db.all<{ v: number | null }>(
        sql`select v from cap_scratch ${cap.indexHint('idx_cap_scratch')} where v is null`,
      ),
    ).toEqual([])
    await cap.reclaimScrubbedStorage(db)
    expect(db.all<{ secure_delete: number }>(sql`PRAGMA secure_delete`)[0]?.secure_delete).toBe(1)
  })

  test('classifyError：结构化 code 单独就能判——不靠 message 正则兜底', () => {
    // 变异验证发现：去掉 SQLITE_CONSTRAINT_UNIQUE 判据后正则兜底照样接住，结构化分支等于没被测。
    // 这里喂一个只有 code、message 不含关键字的错误，锁住结构化路径本身。
    const structuredOnly = new Error('Failed to run the query', {
      cause: Object.assign(new Error('opaque'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    })
    expect(cap.classifyError(structuredOnly)).toBe('unique-violation')
    const busy = new Error('x', {
      cause: Object.assign(new Error('y'), { code: 'SQLITE_BUSY_SNAPSHOT' }),
    })
    expect(cap.classifyError(busy)).toBe('busy')
  })

  test('classifyError：真实 UNIQUE 冲突被分类为 unique-violation', () => {
    const db = scratch()
    db.run(sql`insert into cap_scratch(name) values ('dup')`)
    let caught: unknown
    try {
      db.run(sql`insert into cap_scratch(name) values ('dup')`)
    } catch (error) {
      caught = error
    }
    expect(cap.classifyError(caught)).toBe('unique-violation')
    expect(cap.classifyError(new Error('anything else'))).toBe('other')
  })

  test('readRowSync：驱动本身同步，直接给行 / 无行给 null；uniqueViolationTarget 给撞上的列', () => {
    const db = scratch()
    db.run(sql`insert into cap_scratch(name, v) values ('row', 7)`)
    expect(cap.readRowSync(db, sql`select name, v from cap_scratch where name = ${'row'}`)).toEqual(
      { name: 'row', v: 7 },
    )
    expect(cap.readRowSync(db, sql`select name from cap_scratch where name = ${'none'}`)).toBeNull()
    let caught: unknown
    try {
      db.run(sql`insert into cap_scratch(name) values ('row')`)
    } catch (error) {
      caught = error
    }
    expect(cap.uniqueViolationTarget(caught)).toBe('cap_scratch.name')
    expect(cap.uniqueViolationTarget(new Error('anything else'))).toBeUndefined()
  })
})

// ─── PostgreSQL：真实执行 ─────────────────────────────────────────────────────
//
// 环境门控是**过渡形态**（RFC-359 design §11.1 明确它是反面教材）：无 URL 时 skip 而非 fail。
// 之所以此刻还这么写：CI 的普通 backend 分片今天没有真库，改成 fail 会直接推红主干；
// 真库 lane（ci.yml `test-backend-postgresql`）有一道 grep——本用例一旦 skip 即 lane 红，所以
// 「有库时必跑」是成立的。skip 计 1 次登记进 test-suite-policy 账本。W5-T19e 的
// `describeEachProvider` 落地后本文件迁入并删掉这段门控。
//
// 七个场景收成一个 test：账本只记 1 次 skip，且 lane 的 `(skip).*real PostgreSQL` 必跑判据
// 能覆盖到它（名字里带 real PostgreSQL）。

const PG_URL = process.env['RFC359_DATABASE_URL'] ?? process.env['RFC357_DATABASE_URL']
const PG_URL_ENV =
  process.env['RFC359_DATABASE_URL'] !== undefined ? 'RFC359_DATABASE_URL' : 'RFC357_DATABASE_URL'
const GENERATION_ID = 'dbg_rfc359_capabilities_01'
const OPERATION_ID = 'dbm_rfc359_capabilities_01'
const realTest = PG_URL === undefined ? test.skip : test

describe('RFC-359 能力矩阵 —— PostgreSQL 真实执行', () => {
  const cap = createPostgresqlCapabilities()

  realTest(
    'every capability executes against real PostgreSQL',
    async () => {
      const runtime = createPostgresqlDatabaseRuntime({
        config: {
          provider: 'postgresql',
          urlEnv: PG_URL_ENV,
          poolMax: 4,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
        generationId: GENERATION_ID,
      })
      const pool = runtime.providerPool()
      const raw = (q: string) => pool.unsafe(q)
      let restoreProvider: (() => void) | undefined
      try {
        // 与 rfc357-postgresql-page 同一套姿势：清干净、按基线迁移，然后**自己登记一个活跃生成代**——
        // 客户端的业务写围栏按 runtime.generationId 核对 database_generations，迁移器不替测试登记它。
        await raw('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await raw('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        await migratePostgresqlSchema({ runtime })
        await raw(
          'INSERT INTO "agent_workflow_meta"."logical_copy_operations" ' +
            '(operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) ' +
            `VALUES ('${OPERATION_ID}', 'dbg_rfc359_source', 'digest', 'plan', 'prepared', 1, 1)`,
        )
        await raw(
          'INSERT INTO "agent_workflow_meta"."database_generations" ' +
            '(generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) ' +
            `VALUES ('${GENERATION_ID}', '${OPERATION_ID}', 'dbg_rfc359_source', 'digest', 'active', 1, 1)`,
        )
        // 进程级 provider 投影必须还原：一个 bun 进程跑多个文件，留着会渗进后面的文件（本仓有前科）。
        restoreProvider = selectDatabaseSchemaProvider('postgresql')
        await raw('drop table if exists public.cap_scratch')
        await raw(
          'create table public.cap_scratch(id serial primary key, name text unique, v bigint)',
        )
        const db = createPostgresqlDatabaseClient(runtime)
        const session = createPostgresqlDatabaseSession(db)

        // ① 静态形态
        expect(cap.provider).toBe('postgresql')
        expect(cap.isolation).toBe('read-committed')
        expect(cap.maxBindParameters).toBe(65_535)

        // ② 行锁与 advisory lock 真的执行
        await session.transaction(async (tx) => {
          await tx.run(sql`insert into cap_scratch(name, v) values ('row', 1)`)
          await cap.advisoryLock(tx, 'rfc359-cap')
          await tx.run(sql`select 1 from cap_scratch where name = 'row' for update`)
        })

        // ③ SKIP LOCKED 真的跳过被另一事务锁住的行
        await db.run(sql`insert into cap_scratch(name, v) values ('a', 2), ('b', 3)`)
        let release!: () => void
        const held = new Promise<void>((r) => (release = r))
        const holder = session.transaction(async (tx) => {
          await tx.run(sql`select 1 from cap_scratch where name = 'a' for update`)
          await held
        })
        await new Promise((r) => setTimeout(r, 30))
        const claimed = await session.transaction(async (tx) => {
          const rows = await tx.all<{ name: string }>(
            sql`select name from cap_scratch where name in ('a','b') order by v ${cap.claimLockClause()} limit 1`,
          )
          return rows.map((r) => r.name)
        })
        release()
        await holder
        expect(claimed).toEqual(['b'])

        // ④ NULL 排序：矩阵把 PG 默认（NULL 最大）改回 SQLite 语义
        await db.run(sql`delete from cap_scratch`)
        await db.run(sql`insert into cap_scratch(v) values (2), (null), (1)`)
        const col = sql.raw('v')
        const norm = (v: unknown) => (v === null ? null : cap.numericFromRawRow(v, 'v'))
        const asc = await db.all<{ v: unknown }>(
          sql`select v from cap_scratch order by ${cap.ascNullsFirst(col)}`,
        )
        const desc = await db.all<{ v: unknown }>(
          sql`select v from cap_scratch order by ${cap.descNullsLast(col)}`,
        )
        expect(asc.map((r) => norm(r.v))).toEqual([null, 1, 2])
        expect(desc.map((r) => norm(r.v))).toEqual([2, 1, null])

        // ⑤ ilike + 显式 ESCAPE，与 SQLite 侧同一组输入同一组答案
        await db.run(sql`delete from cap_scratch`)
        for (const n of ['Hello World', 'C:\\build\\out', 'C:build', '100%']) {
          await db.run(sql`insert into cap_scratch(name) values (${n})`)
        }
        const find = async (term: string): Promise<string[]> => {
          const { pattern, escape } = cap.likeEscape(term)
          const rows = await db.all<{ name: string }>(
            sql`select name from cap_scratch where ${cap.likeCaseInsensitive(sql.raw('name'), pattern, escape)}`,
          )
          return rows.map((r) => r.name)
        }
        expect(await find('hello')).toEqual(['Hello World'])
        expect(await find('C:\\build')).toEqual(['C:\\build\\out'])
        expect(await find('100%')).toEqual(['100%'])

        // ⑥ 真实 23505 被识别——SQLSTATE 在 errno 不在 code（F-I-13 的形态）
        await db.run(sql`insert into cap_scratch(name) values ('dup')`)
        let caught: unknown
        try {
          await db.run(sql`insert into cap_scratch(name) values ('dup')`)
        } catch (error) {
          caught = error
        }
        expect(cap.classifyError(caught)).toBe('unique-violation')
        // ⑩ 唯一冲突的目标是约束名；同步读在网络驱动上不可用（undefined，调用方退回缓存）
        expect(cap.uniqueViolationTarget(caught)).toBe('cap_scratch_name_key')
        expect(cap.uniqueViolationTarget(new Error('anything else'))).toBeUndefined()
        expect(cap.readRowSync(db, sql`select 1 as one`)).toBeUndefined()

        // ⑧ serializable()：两个并发事务对同一行读—改—写，SERIALIZABLE 下必有一方 40001；
        //    重试后两次自增都落地。这条证明 opt-in 的重试路径真的在真库上工作。
        await db.run(sql`delete from cap_scratch`)
        await db.run(sql`insert into cap_scratch(name, v) values ('counter', 0)`)
        const bump = () =>
          session.serializable(async (tx) => {
            const [row] = await tx.all<{ v: unknown }>(
              sql`select v from cap_scratch where name = 'counter'`,
            )
            const next = cap.numericFromRawRow(row!.v, 'v') + 1
            await new Promise((r) => setTimeout(r, 15)) // 让两笔交叠
            await tx.run(sql`update cap_scratch set v = ${next} where name = 'counter'`)
          })
        await Promise.all([bump(), bump()])
        const [after] = await db.all<{ v: unknown }>(
          sql`select v from cap_scratch where name = 'counter'`,
        )
        expect(cap.numericFromRawRow(after!.v, 'v')).toBe(2)

        // ⑨ 索引提示在 PG 上为空（planner 自己选）；擦除后的存储回收是 no-op（autovacuum 负责）
        expect(render(cap.indexHint('idx_cap_scratch'))).toBe('')
        await cap.reclaimScrubbedStorage(db)

        // ⑦ bigint 经驱动回来是字符串，矩阵归一成 number
        await db.run(sql`delete from cap_scratch`)
        await db.run(sql`insert into cap_scratch(v) values (1788278410000)`)
        const [row] = await db.all<{ v: unknown }>(sql`select v from cap_scratch`)
        expect(typeof row!.v).toBe('string')
        expect(cap.numericFromRawRow(row!.v, 'v')).toBe(1788278410000)
      } finally {
        restoreProvider?.()
        try {
          await raw('drop table if exists public.cap_scratch')
        } catch {
          // 清理失败不掩盖测试本身的结果
        }
        await runtime.close()
      }
    },
    60_000,
  )
})
