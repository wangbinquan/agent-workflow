// RFC-395 I-b: retain every RFC-349 client behavior through native bun-sql.
// RFC-349 T3/T5 — proves the runtime query client uses the pgTable projection,
// PostgreSQL bind markers/native booleans, and one reserved session per atomic
// transaction instead of a synchronous SQLite shadow connection.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createPostgresqlDatabaseSession } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  first,
  rawRows,
  rawExec,
  rawFirst,
  affectedRows,
} from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
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
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: (query, parameters) => run('reserved', query, parameters),
    release() {
      releases += 1
    },
  })
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

    const { agents } = tablesOf(db)
    const rows = await db
      .select({ id: agents.id, enabled: agents.syncOutputsOnIterate })
      .from(agents)
      .where(sql`${agents.syncOutputsOnIterate} = ${true}`)

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

    const { agents } = tablesOf(db)
    expect(await first(db.select({ id: agents.id }).from(agents).limit(1))).toBeUndefined()
  })

  test('normalizes mutation count and supports object-mode raw queries', async () => {
    const fake = fixture()
    fake.queued.push(
      { count: 0 },
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { objects: [{ generation_id: 'dbg_pg_client_01' }] },
      { count: 1 },
      { count: 0 },
      { objects: [{ one: 1 }] },
    )
    const db = createPostgresqlDatabaseClient(fake.runtime)

    const { agents } = tablesOf(db)
    const mutation = await db.insert(agents).values({ id: 'agent-1', name: 'Agent' })
    expect(affectedRows(mutation)).toBe(1)
    expect(await rawRows<{ one: number }>(db, sql`select 1 as one`, { one: 'int' })).toEqual([
      { one: 1 },
    ])
    const businessWrite = fake.executions.find((execution) =>
      execution.sql.includes('insert into "agent_workflow"."agents"'),
    )!
    expect(businessWrite.sql).toContain('default')
    expect(businessWrite.parameters).toEqual(['agent-1', 'Agent'])
    expect(
      fake.executions.some((execution) => execution.sql.includes('database_generations')),
    ).toBe(true)
    expect(fake.releases).toBe(1)
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
      const { agents } = tablesOf(transaction)
      const mutation = await insertOne(transaction, agents, { id: 'agent-1', name: 'Agent' })
      return affectedRows(mutation)
    })

    expect(receipt).toBe(1)
    // Marker and fence both ride the caller's own reserved session: reserving a
    // nested connection here is a measured Bun.SQL pooling hazard.
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('insert into "agent_workflow"."agents"'),
      'commit',
    ])
    expect(fake.releases).toBe(1)
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
    const failure = await Promise.resolve(rawExec(db, sql`PRAGMA quick_check`)).catch(
      (error: unknown) => error,
    )
    const cause = failure instanceof Error ? failure.cause : undefined
    expect(cause).toBeInstanceOf(Error)
    expect(String(cause)).toContain('SQLite-only database operation cannot run on PostgreSQL')
    expect(fake.executions).toHaveLength(0)
  })

  test('fails closed and rolls back when the generation is no longer active', async () => {
    const fake = fixture()
    fake.queued.push({ count: 0 }, { objects: [] }, { objects: [] }, { count: 0 })
    const db = createPostgresqlDatabaseClient(fake.runtime)

    let failure: unknown
    try {
      const { agents } = tablesOf(db)
      await db.insert(agents).values({ id: 'agent-1', name: 'Agent' })
    } catch (error) {
      failure = error
    }
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(PostgresqlGenerationFenceError)
    expect(fake.executions.map((execution) => execution.sql.trim().toLowerCase())).toEqual([
      'begin',
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      'rollback',
    ])
    expect(fake.releases).toBe(1)
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
      { count: 0 }, // begin
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // one-shot marker
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // fence
      { count: 1 }, // insert
      { count: 0 }, // commit
      { count: 0 }, // begin
      { objects: [{ generation_id: 'dbg_pg_client_01' }] }, // fence
      { count: 1 }, // insert
      { count: 0 }, // commit
    )
    const db = createPostgresqlDatabaseClient(fake.runtime)

    const { agents } = tablesOf(db)
    await insertOne(db, agents, { id: 'agent-1', name: 'Agent' })
    await db.insert(agents).values({ id: 'agent-2', name: 'Agent' })

    const markers = fake.executions.filter((execution) => execution.sql.startsWith('WITH marked'))
    expect(markers).toHaveLength(1)
    // The caller's own reserved session — never a nested reservation.
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

// RFC-370 M3: a maintenance worker borrows one exact execution lease. Neither
// the single-row INSERT optimization nor a raw query may bypass that fence.
test('deployment write guard shares the reserved transaction, rejects before mutation, and leaves reads available', async () => {
  const fake = fixture()
  const guardFailure = new Error('worker lease replaced')
  const rejectsGuard = async (operation: unknown) => {
    const error = await Promise.resolve(operation).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    // Drizzle wraps query failures; require the exact original guard error as the cause.
    expect(error instanceof Error ? (error.cause ?? error) : error).toBe(guardFailure)
  }
  let calls = 0
  const db = createPostgresqlDatabaseClient(fake.runtime, {
    async beforeWrite(tx) {
      calls += 1
      await rawRows(
        tx,
        sql`SELECT id FROM hosted_execution_control WHERE id = ${'global'} FOR UPDATE`,
      )
      throw guardFailure
    },
  })
  await rawRows(db, sql`SELECT 1`)
  expect(calls).toBe(0)
  const statements = [
    () => rawExec(db, sql`INSERT INTO agents (id) VALUES (${'guarded'})`),
    () => rawRows(db, sql`UPDATE agents SET name = ${'x'} RETURNING id`),
    () => rawFirst(db, sql`DELETE FROM agents RETURNING id`),
    () =>
      Promise.resolve(rawRows(db, sql`UPDATE agents SET name = ${'x'} RETURNING id`)).then((rows) =>
        rows.map((row) => Object.values(row)),
      ),
    () => {
      const { agents } = tablesOf(db)
      return db.update(agents).set({ name: 'x' }).returning()
    },
    () => {
      const { agents } = tablesOf(db)
      return insertOne(db, agents, {
        id: 'guarded',
        name: 'guarded',
        bodyMd: '',
        createdAt: 1,
        updatedAt: 1,
      })
    },
  ]
  for (const statement of statements) {
    const offset = fake.executions.length
    await rejectsGuard(statement())
    const attempted = fake.executions.slice(offset)
    expect(attempted[0]?.sql).toBe('BEGIN')
    expect(attempted.at(-1)?.sql).toBe('ROLLBACK')
    expect(attempted.every((entry) => entry.owner === 'reserved')).toBe(true)
    expect(attempted.some((entry) => /^(insert|update|delete)/i.test(entry.sql))).toBe(false)
  }
  expect(calls).toBe(statements.length)
  expect(fake.releases).toBe(statements.length)
  const offset = fake.executions.length
  await rejectsGuard(
    db.transaction(async (tx) => {
      await rawRows(tx, sql`SELECT 1`)
      const { agents } = tablesOf(tx)
      await tx.update(agents).set({ name: 'x' })
    }),
  )
  const transaction = fake.executions.slice(offset)
  expect(transaction.every((entry) => entry.owner === 'reserved')).toBe(true)
  expect(transaction.filter((entry) => /^begin/i.test(entry.sql))).toHaveLength(1)
  expect(transaction.filter((entry) => /^rollback/i.test(entry.sql))).toHaveLength(1)
  expect(fake.releases).toBe(statements.length + 1)
})

// RFC-370 v3 V7: the deployment write guard used to run before every write
// statement of a transaction (and took its locks again each time). It runs once
// per transaction now — its locks are held until the transaction ends — and
// again for the next transaction.
test('deployment write guard runs once per transaction and again for the next one', async () => {
  const fake = fixture()
  let calls = 0
  const db = createPostgresqlDatabaseClient(fake.runtime, {
    async beforeWrite() {
      calls += 1
    },
  })
  const generation = { objects: [{ generation_id: 'dbg_pg_client_01' }] }
  fake.queued.push(
    { count: 0 }, // begin
    generation, // one-shot marker
    generation, // fence
    { count: 1 }, // insert
    generation, // fence
    { count: 1 }, // insert
    { count: 0 }, // commit
    { count: 0 }, // begin
    generation, // fence
    { count: 1 }, // insert
    { count: 0 }, // commit
  )
  await db.transaction(async (tx) => {
    const { agents } = tablesOf(tx)
    await insertOne(tx, agents, { id: 'agent-1', name: 'Agent' })
    await insertOne(tx, agents, { id: 'agent-2', name: 'Agent' })
  })
  expect(calls).toBe(1)
  await db.transaction(async (tx) => {
    const { agents } = tablesOf(tx)
    await insertOne(tx, agents, { id: 'agent-3', name: 'Agent' })
  })
  expect(calls).toBe(2)
  expect(fake.executions.filter((execution) => /^insert/i.test(execution.sql.trim()))).toHaveLength(
    3,
  )
})

// RFC-395 I-b: native transaction configuration and savepoints stay on the reserved connection.
test('snapshot isolation is set by native PgTransactionConfig before its first read', async () => {
  const fake = fixture()
  fake.queued.push({}, {}, { objects: [{ one: 1 }] }, {})
  const db = createPostgresqlDatabaseClient(fake.runtime)
  const session = createPostgresqlDatabaseSession(db)
  expect(
    await session.snapshotRead((tx) => Promise.resolve(rawFirst(tx, sql`select 1 as one`))),
  ).toEqual({ one: 1 })
  expect(fake.executions.map((row) => row.sql.toLowerCase())).toEqual([
    'begin',
    'set transaction isolation level repeatable read read only',
    'select 1 as one',
    'commit',
  ])
  expect(fake.executions.every((row) => row.owner === 'reserved')).toBe(true)
  expect(fake.releases).toBe(1)
})

test('native savepoints inherit the session tables and roll back independently', async () => {
  const fake = fixture()
  const db = createPostgresqlDatabaseClient(fake.runtime)
  const failure = new Error('nested-failure')
  await db.transaction(async (tx) => {
    expect(tablesOf(tx)).toBe(tablesOf(db))
    await expect(
      tx.transaction(async (nested) => {
        expect(tablesOf(nested)).toBe(tablesOf(db))
        throw failure
      }),
    ).rejects.toBe(failure)
    await tx.transaction(async (nested) => {
      await rawRows(nested, sql`select 1`)
    })
  })
  expect(fake.executions.every((row) => row.owner === 'reserved')).toBe(true)
  expect(fake.executions.map((row) => row.sql)).toEqual([
    'BEGIN',
    'SAVEPOINT fixture_savepoint_1',
    'ROLLBACK TO SAVEPOINT fixture_savepoint_1',
    'SAVEPOINT fixture_savepoint_2',
    'select 1',
    'RELEASE SAVEPOINT fixture_savepoint_2',
    'COMMIT',
  ])
  expect(fake.releases).toBe(1)
})
