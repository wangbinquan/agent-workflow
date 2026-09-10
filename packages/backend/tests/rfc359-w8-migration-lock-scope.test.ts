// RFC-359 W8 —— schema 准备锁的**作用域**：按库隔离，同库互斥。
//
// 这条测试的来历（一次被红先写救回来的误改）
// ---------------------------------------------------------------------------
// 2026-09-11 量 harness 开销时，我读到 `migratePostgresqlSchema` 用
// `pg_try_advisory_lock(hashtextextended($1, 0))` 抢锁、`$1` 是纯字符串常量，又想起
// `docs/dev-gotchas.md` 当时记着「PostgreSQL 的 advisory lock 是**集群级**的」，于是判定这是一处
// **锁作用域写错**的功能缺陷：同一集群上两个不同库的部署会互相判成「另一个进程正在准备 schema」。
//
// **先写红，结果它是绿的。** 那句 gotcha 的机制说法是错的——实测 `pg_locks` 里 `locktype='advisory'`
// 的行带**非零 `database` OID**，同键不同库不互斥、同键同库互斥。生产代码本来就是对的，
// 我差点去改一处没坏的迁移锁。gotcha 已按实测更正。
//
// 测试留下来，因为它钉住的性质是**真实且有人要依赖的**
// ---------------------------------------------------------------------------
// `docs/audit-backlog.md` 记的 harness 那一刀（每文件一个数据库，用来同时消掉 40P01 死锁与跨文件
// 数据互踩）**整个建立在「按库隔离也隔离锁」这条性质上**。它今天成立，但没有任何测试钉着它：
// 一旦哪天锁键改成不带库身份的全局形态（例如换成 `pg_advisory_lock` 的两参数形式并塞进一个
// 常量 classid），那条隔离路线会**静默失效**，表现是 CI 上零星的 `postgresql-schema-lock-held`。
//
// 两条判据，缺一不可：
//   ① **不同库不互斥**——每文件一库这条路线的前提；
//   ② **同库仍 fail-fast**——那把锁真正要保的东西：两个部署指向同一个库时不能同时 DDL。
//
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

import {
  migratePostgresqlSchema,
  PostgresqlMigrationError,
} from '@/platform/persistence/postgresqlMigrator'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'

const URL_ENV = resolvePostgresqlTestUrlEnv(process.env)
const BASE_URL = URL_ENV === undefined ? undefined : process.env[URL_ENV]

/** 本轮两个一次性库的名字：跑完即删，不与 harness 的 `awtest` 撞。 */
const DB_A = `aw_lockscope_a_${String(process.pid)}`
const DB_B = `aw_lockscope_b_${String(process.pid)}`

function urlFor(database: string): string {
  const url = new URL(BASE_URL ?? '')
  url.pathname = `/${database}`
  return url.toString()
}

/** 指向某个库的 runtime；env 变量名按库唯一，避免两条 runtime 抢同一个名字。 */
function runtimeFor(database: string): PostgresqlDatabaseRuntime {
  const envName = `AW_LOCKSCOPE_URL_${database.toUpperCase()}`
  return createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: envName,
      poolMax: 2,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 10_000,
    },
    generationId: `gen-${database}`,
    env: { [envName]: urlFor(database) },
  })
}

async function admin<T>(run: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(BASE_URL ?? '')
  try {
    return await run(sql)
  } finally {
    await sql.close()
  }
}

/**
 * 本条锁的是 PostgreSQL 专属机制，所以它跟着 `AW_TEST_PROVIDERS` 走：
 *   · 选了 postgresql（缺省）却没给 URL ⇒ **红**（与 `describeEachProvider` 同一条纪律：
 *     「无库则跳过」正是 dual-provider-parity 审计里 12 条 P0 穿过验收的机制）；
 *   · 显式只选 sqlite ⇒ 整条 describe 不注册。macOS / Windows 原生 lane 就是这一档
 *     （它们没有 PostgreSQL 服务容器），初版把这两档混成一条「缺库即红」，当场把 macOS 分片推红。
 */
const postgresqlSelected = resolveTestProviders(process.env).includes('postgresql')
const configured = BASE_URL !== undefined && BASE_URL.length > 0

const suite = postgresqlSelected ? describe : describe.skip

suite('RFC-359 W8 —— schema 准备锁按库隔离', () => {
  beforeAll(async () => {
    if (!configured) return
    await admin(async (sql) => {
      for (const name of [DB_A, DB_B]) {
        // 上一轮若留下连接，`drop database` 会失败——先把别人的会话踢掉再删。
        // （实撞：紧接着复跑一次，第二次的 beforeAll 撞上前一次尚未排空的连接。）
        await sql.unsafe(
          'select pg_terminate_backend(pid) from pg_stat_activity ' +
            'where datname = $1 and pid <> pg_backend_pid()',
          [name],
        )
        await sql.unsafe(`drop database if exists ${name}`)
        await sql.unsafe(`create database ${name}`)
      }
    })
  })

  afterAll(async () => {
    if (!configured) return
    await admin(async (sql) => {
      for (const name of [DB_A, DB_B]) {
        await sql.unsafe(
          'select pg_terminate_backend(pid) from pg_stat_activity ' +
            'where datname = $1 and pid <> pg_backend_pid()',
          [name],
        )
        await sql.unsafe(`drop database if exists ${name}`)
      }
    })
  })

  // 设计上的硬判据：缺库即红，不是 skip（与 `describeEachProvider` 同一条纪律）。
  test('PostgreSQL 未配置——本条锁的是 PG 专属机制，缺库即红', () => {
    expect(
      configured,
      '把 AW_TEST_POSTGRESQL_URL（或 RFC357_DATABASE_URL）指向一个可以建库/删库的 PostgreSQL 集群',
    ).toBe(true)
  })

  test('① 同集群的两个不同库可以并发准备 schema——它们本就互不相干', async () => {
    const [a, b] = [runtimeFor(DB_A), runtimeFor(DB_B)]
    try {
      const settled = await Promise.allSettled([
        migratePostgresqlSchema({ runtime: a }),
        migratePostgresqlSchema({ runtime: b }),
      ])
      const rejected = settled.flatMap((entry) =>
        entry.status === 'rejected' ? [entry.reason as Error] : [],
      )
      expect(
        rejected.map((error) =>
          error instanceof PostgresqlMigrationError
            ? error.code
            : `${error.name}: ${error.message}`,
        ),
        '两个库各自准备各自的 schema，不该互相判定为「另一个进程正在准备」——' +
          'advisory lock 是集群级的，锁键里必须带上库的身份。',
      ).toEqual([])
    } finally {
      await Promise.allSettled([a.close?.(), b.close?.()])
    }
  }, 120_000)

  test('② 同一个库上的第二次准备仍然 fail-fast（这把锁真正要保的东西）', async () => {
    const first = runtimeFor(DB_A)
    const second = runtimeFor(DB_A)
    try {
      let release: (() => void) | undefined
      let reached: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      // **必须等第一笔真的握上锁再发第二笔**。初版直接「发了第一笔就发第二笔」，两者谁先抢到锁
      // 是随机的——它靠运气绿过三次，然后在一次普通复跑里红了。`afterCommitted` 跑在锁仍持有的
      // 窗口内（`migratePostgresqlSchema` 的 finally 才释放），所以它是「已握锁」的确定信号。
      const firstHoldsLock = new Promise<void>((resolve) => {
        reached = resolve
      })
      const running = migratePostgresqlSchema({
        runtime: first,
        afterCommitted: async () => {
          reached?.()
          await held
        },
      })
      await firstHoldsLock
      const loser = await migratePostgresqlSchema({ runtime: second }).then(
        () => null,
        (error: unknown) => error,
      )
      release?.()
      await running
      expect(
        loser instanceof PostgresqlMigrationError ? loser.code : loser,
        '同一个库上并发准备 schema 必须 fail-fast——放宽库间互斥不能把这条一起放宽',
      ).toBe('postgresql-schema-lock-held')
    } finally {
      await Promise.allSettled([first.close?.(), second.close?.()])
    }
  }, 120_000)
})
