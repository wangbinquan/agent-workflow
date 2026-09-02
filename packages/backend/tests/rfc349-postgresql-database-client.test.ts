// RFC-349 T3/T5 — proves the runtime query client uses the pgTable projection,
// PostgreSQL bind markers/native booleans, and one reserved session per atomic
// transaction instead of a synchronous SQLite shadow connection.

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { agents } from '@/db/schema'
import {
  createPostgresqlDatabaseClient,
  PostgresqlGenerationFenceError,
} from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

interface Execution {
  readonly owner: 'pool' | 'reserved'
  readonly sql: string
  readonly parameters: readonly unknown[] | undefined
}

function result(
  objects: readonly Record<string, unknown>[],
  values: readonly (readonly unknown[])[],
  count = objects.length,
): SqlRows {
  const rows = [...objects] as Array<Record<string, unknown>> & { count?: number }
  rows.count = count
  return Object.assign(Promise.resolve(rows), {
    async values() {
      return values
    },
  })
}

function fixture() {
  const executions: Execution[] = []
  const queued: Array<{
    readonly objects?: readonly Record<string, unknown>[]
    readonly values?: readonly (readonly unknown[])[]
    readonly count?: number
  }> = []
  let releases = 0

  const run = (owner: Execution['owner'], query: string, parameters?: readonly unknown[]) => {
    executions.push({ owner, sql: query, parameters })
    const response = queued.shift() ?? {}
    return result(response.objects ?? [], response.values ?? [], response.count)
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: (query, parameters) => run('reserved', query, parameters),
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: (query, parameters) => run('pool', query, parameters),
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_pg_client_01',
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
  return {
    runtime,
    executions,
    queued,
    get releases() {
      return releases
    },
  }
}

describe('RFC-349 PostgreSQL database client', () => {
  test('uses schema-qualified pgTable columns and native boolean parameters', async () => {
    const fake = fixture()
    fake.queued.push({ values: [['agent-1', true]] })
    const db = createPostgresqlDatabaseClient(fake.runtime)

    const rows = await db
      .select({ id: agents.id, enabled: agents.syncOutputsOnIterate })
      .from(agents)
      .where(sql`${agents.syncOutputsOnIterate} = ${true}`)
      .all()

    expect(rows).toEqual([{ id: 'agent-1', enabled: true }])
    expect(fake.executions).toHaveLength(1)
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."agents"')
    expect(fake.executions[0]?.sql).toContain('= $1')
    expect(fake.executions[0]?.parameters).toEqual([true])
  })

  test('maps an empty get result to undefined instead of an all-undefined row', async () => {
    const fake = fixture()
    fake.queued.push({ values: [] })
    const db = createPostgresqlDatabaseClient(fake.runtime)

    expect(await db.select({ id: agents.id }).from(agents).limit(1).get()).toBeUndefined()
  })

  test('normalizes mutation count and supports object-mode raw queries', async () => {
    const fake = fixture()
    fake.queued.push(
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { count: 0 },
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { count: 1 },
      { count: 0 },
      { objects: [{ one: 1 }] },
    )
    const db = createPostgresqlDatabaseClient(fake.runtime)

    const mutation = await db.insert(agents).values({ id: 'agent-1', name: 'Agent' }).run()
    expect((mutation as { changes?: number }).changes).toBe(1)
    expect(await db.all<{ one: number }>(sql`select 1 as one`)).toEqual([{ one: 1 }])
    const businessWrite = fake.executions.find((execution) =>
      execution.sql.includes('insert into "agent_workflow"."agents"'),
    )!
    expect(businessWrite.parameters).toContain(false)
    expect(businessWrite.sql).toContain('(extract(epoch from clock_timestamp()) * 1000)')
    expect(
      fake.executions.some((execution) => execution.sql.includes('database_generations')),
    ).toBe(true)
    // The write's own reserved session plus the one-shot marker's.
    expect(fake.releases).toBe(2)
  })

  test('pins begin, business statements and commit to one reserved connection', async () => {
    const fake = fixture()
    fake.queued.push(
      { count: 0 },
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { count: 1 },
      { count: 0 },
    )
    const db = createPostgresqlDatabaseClient(fake.runtime)

    const receipt = await db.transaction(async (transaction) => {
      const mutation = await transaction
        .insert(agents)
        .values({ id: 'agent-1', name: 'Agent' })
        .run()
      return (mutation as { changes?: number }).changes
    })

    expect(receipt).toBe(1)
    // The one-shot live-write marker is the only statement that leaves the
    // transaction: it commits on its own reserved connection so concurrent
    // first writers cannot abort each other's SERIALIZABLE transaction.
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('insert into "agent_workflow"."agents"'),
      'commit',
    ])
    expect(fake.releases).toBe(2)
  })

  test('rolls back and releases the reserved connection on failure', async () => {
    const fake = fixture()
    fake.queued.push({ count: 0 }, { count: 0 })
    const db = createPostgresqlDatabaseClient(fake.runtime)

    await expect(
      db.transaction(async () => {
        throw new Error('business-failure')
      }),
    ).rejects.toThrow('business-failure')
    // No business statement ran, so neither the marker nor the fence is reached.
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      'rollback',
    ])
    expect(fake.releases).toBe(1)
  })

  test('does not route SQLite physical operations to the pool', async () => {
    const fake = fixture()
    const db = createPostgresqlDatabaseClient(fake.runtime)
    await expect(db.run(sql`PRAGMA quick_check`)).rejects.toThrow(
      'SQLite-only database operation cannot run on PostgreSQL',
    )
    expect(fake.executions).toHaveLength(0)
  })

  test('fails closed and rolls back when the generation is no longer active', async () => {
    const fake = fixture()
    fake.queued.push({ objects: [] }, { count: 0 }, { objects: [] }, { count: 0 })
    const db = createPostgresqlDatabaseClient(fake.runtime)

    let failure: unknown
    try {
      await db.insert(agents).values({ id: 'agent-1', name: 'Agent' }).run()
    } catch (error) {
      failure = error
    }
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(PostgresqlGenerationFenceError)
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      'begin',
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      'rollback',
    ])
    expect(fake.releases).toBe(2)
  })

  // RFC-349 —— 托管取证跑（真外置 PostgreSQL、2 客户端、12 秒）里，这一条曾经
  // 以 38 次 `could not serialize access due to concurrent update` 收场：旧写法
  // `SET first_live_write_at = COALESCE(first_live_write_at, now)` 在**每一条**
  // 业务语句上重写同一行，任意两个并发 SERIALIZABLE 事务（含每个已认证请求顺手
  // 做的 session touch）必然互撞，撞出来的 500 与调用方无关。下面两条锁住修法的
  // 两个性质：写一次就不再写、并且只写一次。
  test('the live-write marker never rewrites a generation it already marked', async () => {
    const fake = fixture()
    fake.queued.push(
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // one-shot marker
      { count: 0 }, // begin
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // fence
      { count: 1 }, // insert
      { count: 0 }, // commit
      { count: 0 }, // begin
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // fence
      { count: 1 }, // insert
      { count: 0 }, // commit
    )
    const db = createPostgresqlDatabaseClient(fake.runtime)

    await db.insert(agents).values({ id: 'agent-1', name: 'Agent' }).run()
    await db.insert(agents).values({ id: 'agent-2', name: 'Agent' }).run()

    const markers = fake.executions.filter((execution) => execution.sql.startsWith('WITH marked'))
    expect(markers).toHaveLength(1)
    // Its own reserved session, never the caller's — see markFirstGenerationWrite.
    expect(markers[0]?.owner).toBe('reserved')
    expect(markers[0]?.sql).toContain('first_live_write_at IS NULL')
    expect(markers[0]?.sql).not.toContain('COALESCE')
    // Both writes still fence, and both fence reads stay on the reserved session.
    const fences = fake.executions.filter((execution) =>
      execution.sql.startsWith('SELECT generation_id FROM "agent_workflow_meta"'),
    )
    expect(fences).toHaveLength(2)
    expect(fences.every((execution) => execution.owner === 'reserved')).toBe(true)
  })
})
