// SQL AST reuse must keep every original prepare/all, decoder and statement
// boundary. Proxy probes stop at the actual client boundary, without PG I/O.
import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Name, Param, Placeholder, SQL, StringChunk, eq } from 'drizzle-orm'
import { SQLiteDialect } from 'drizzle-orm/sqlite-core'
import { SQLiteSession } from 'drizzle-orm/sqlite-core/session'
import { PreparedQuery as BunPreparedQuery } from 'drizzle-orm/bun-sqlite/session'
import { RemotePreparedQuery } from 'drizzle-orm/sqlite-proxy/session'
import { buildActor } from '@/auth/actor'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { tasks, workflows } from '@/db/schema'
import { createTaskOverviewQuery } from '@/modules/task-execution/infrastructure/taskOverviewQuery'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import type { RecordedStatement, StatementRecording } from './helpers/statementRecorder'

const T0 = 1_700_000_000_000
const actor = buildActor({
  user: { id: 'w25-user', username: 'w25', displayName: 'w25', role: 'admin', status: 'active' },
  source: 'session',
})
const initial = { running: 1, awaiting: 2, done7d: 1, failed7d: 1 }

async function seed(harness: ProviderHarness) {
  await harness.db.insert(workflows).values({ id: 'w25-wf', name: 'w25', definition: '{}' })
  const rows = [
    { id: 'w25-run', status: 'running' },
    { id: 'w25-child', status: 'running', parentTaskId: 'w25-run' },
    { id: 'w25-review', status: 'awaiting_review' },
    { id: 'w25-human', status: 'awaiting_human' },
    { id: 'w25-done', status: 'done', finishedAt: T0 },
    { id: 'w25-old', status: 'done', finishedAt: T0 - 1 },
    { id: 'w25-failed', status: 'failed', finishedAt: T0 },
    { id: 'w25-unfinished', status: 'failed', finishedAt: null },
  ] as const
  for (const row of rows) {
    await harness.db.insert(tasks).values({
      workflowId: 'w25-wf',
      workflowSnapshot: '{}',
      inputs: '{}',
      repoPath: '/fixture/w25',
      worktreePath: `/fixture/${row.id}`,
      name: row.id,
      baseBranch: 'main',
      branch: `task/${row.id}`,
      startedAt: T0,
      branchStartedAt: T0,
      rootTaskId: row.id,
      lineageSlotPathJson: '[]',
      catalogVisibility: 'public',
      ...row,
    })
  }
}

function countStatements(statements: readonly RecordedStatement[]) {
  return statements.filter((statement) => /^select count\(\*\) from /.test(statement.sql))
}
function statementContract(statements: readonly RecordedStatement[]) {
  return countStatements(statements)
    .map(({ sql, params, values, rows }) => ({ sql, params, values, rows }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

// Walk only actual SQL node containers. Table/column/decoder objects remain
// opaque identity leaves; descriptor flags and every SQL-owned array are kept.
function createAstObserver() {
  const identities = new WeakMap<object, number>()
  let nextIdentity = 1
  function identity(value: object): number {
    const previous = identities.get(value)
    if (previous !== undefined) return previous
    identities.set(value, nextIdentity)
    return nextIdentity++
  }
  function container(value: unknown): value is object {
    return (
      Array.isArray(value) ||
      value instanceof SQL ||
      value instanceof SQL.Aliased ||
      value instanceof Name ||
      value instanceof Param ||
      value instanceof Placeholder ||
      value instanceof StringChunk
    )
  }
  return (root: SQL): string => {
    const seen = new Set<object>()
    const nodes: unknown[] = []
    function visit(value: unknown): void {
      if (!container(value) || seen.has(value)) return
      seen.add(value)
      const properties: unknown[] = []
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        const item: unknown = descriptor.value
        const reference =
          (typeof item === 'object' && item !== null) || typeof item === 'function'
            ? { identity: identity(item) }
            : { primitive: item, type: typeof item }
        properties.push({
          key: String(key),
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          getter: descriptor.get === undefined ? null : identity(descriptor.get),
          setter: descriptor.set === undefined ? null : identity(descriptor.set),
          reference,
        })
        visit(item)
      }
      nodes.push({ identity: identity(value), properties })
    }
    visit(root)
    return JSON.stringify(nodes)
  }
}

function observeCountCompilation() {
  const snapshot = createAstObserver()
  const roots = new Set<SQL>()
  const retained: { root: SQL; before: string }[] = []
  const originalBuild = SQLiteDialect.prototype.buildSelectQuery
  const originalCompile = SQLiteDialect.prototype.sqlToQuery
  let generations = 0
  const build = spyOn(SQLiteDialect.prototype, 'buildSelectQuery').mockImplementation(function (
    this: SQLiteDialect,
    input: Parameters<typeof originalBuild>[0],
  ) {
    const result = originalBuild.call(this, input)
    if (Object.keys(input.fields).join(',') === 'value') {
      generations += 1
      roots.add(result)
    }
    return result
  })
  const compile = spyOn(SQLiteDialect.prototype, 'sqlToQuery').mockImplementation(function (
    this: SQLiteDialect,
    query: SQL,
    source: Parameters<typeof originalCompile>[1],
  ) {
    const before = roots.has(query) ? snapshot(query) : undefined
    const result = originalCompile.call(this, query, source)
    if (before !== undefined) {
      expect(snapshot(query)).toBe(before)
      retained.push({ root: query, before })
    }
    return result
  })
  const prepare = spyOn(SQLiteSession.prototype, 'prepareOneTimeQuery')
  const nativeAll = spyOn(BunPreparedQuery.prototype, 'all')
  const remoteAll = spyOn(RemotePreparedQuery.prototype, 'all')
  return {
    finish() {
      try {
        for (const { root, before } of retained) expect(snapshot(root)).toBe(before)
        return {
          generations,
          compilations: retained.length,
          prepares: prepare.mock.calls.filter(([query]) =>
            /^select count\(\*\) from /.test(query.sql),
          ).length,
          allCalls: nativeAll.mock.calls.length + remoteAll.mock.calls.length,
        }
      } finally {
        build.mockRestore()
        compile.mockRestore()
        prepare.mockRestore()
        nativeAll.mockRestore()
        remoteAll.mockRestore()
      }
    },
  }
}

describeEachProvider('RFC359 W25 overview SQL template semantics', (harness) => {
  test('retained owner preserves complete rows, late recording and fresh count bindings', async () => {
    await seed(harness)
    const before = await harness.db.select().from(tasks).orderBy(tasks.id).all()
    console.log(
      'RFC359_W25_OVERVIEW_ROWS ' +
        JSON.stringify({
          rows: before.length,
          fields: before.reduce((total, row) => total + Object.keys(row).length, 0),
          digest: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
        }),
    )
    const owner = createTaskOverviewQuery(harness.db)
    const meter = observeCountCompilation()
    let metrics: ReturnType<typeof meter.finish>
    let second: StatementRecording | undefined
    let third: StatementRecording | undefined
    try {
      expect(await owner.load({ actor, since: T0 })).toEqual(initial)
      second = harness.recordStatements()
      expect(await owner.load({ actor, since: T0 + 1 })).toEqual({
        ...initial,
        done7d: 0,
        failed7d: 0,
      })
      second.stop()
      const frozenSecond = JSON.stringify(second.statements)
      third = harness.recordStatements()
      expect(await owner.load({ actor, since: T0 })).toEqual(initial)
      third.stop()
      expect(JSON.stringify(second.statements)).toBe(frozenSecond)
      expect(countStatements(second.statements)).toHaveLength(4)
      expect(countStatements(third.statements)).toHaveLength(4)
    } finally {
      third?.stop()
      second?.stop()
      metrics = meter.finish()
    }
    if (third === undefined) throw new Error('missing actual third recording')
    expect(metrics.compilations).toBe(12)
    expect(metrics.prepares).toBe(12)
    expect(metrics.allCalls).toBe(12)
    expect(metrics.generations).toBeGreaterThan(0)
    expect(metrics.generations).toBeLessThanOrEqual(metrics.compilations)
    console.log('RFC359_W25_OVERVIEW_COMPILATION ' + JSON.stringify(metrics))
    const reference = harness.recordStatements()
    try {
      const value = await createTaskOverviewQuery(harness.db).load({ actor, since: T0 })
      expect(value).toEqual(initial)
      expect(Object.keys(value)).toEqual(['running', 'awaiting', 'done7d', 'failed7d'])
      expect(Object.values(value).every((item) => typeof item === 'number')).toBe(true)
      expect(statementContract(third.statements)).toEqual(statementContract(reference.statements))
    } finally {
      reference.stop()
    }
    expect(await harness.db.select().from(tasks).orderBy(tasks.id).all()).toEqual(before)
  })

  test('the original transaction-bound owner sees writes and rollback restores every row', async () => {
    await seed(harness)
    const before = await harness.db.select().from(tasks).orderBy(tasks.id).all()
    const rollback = new Error('w25-count-rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const owner = createTaskOverviewQuery(tx)
        expect(await owner.load({ actor, since: T0 })).toEqual(initial)
        await tx
          .update(tasks)
          .set({ status: 'done', finishedAt: T0 })
          .where(eq(tasks.id, 'w25-run'))
          .run()
        expect(await owner.load({ actor, since: T0 })).toEqual({
          ...initial,
          running: 0,
          done7d: 2,
        })
        expect(await owner.load({ actor, since: T0 + 1 })).toEqual({
          running: 0,
          awaiting: 2,
          done7d: 0,
          failed7d: 0,
        })
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(await harness.db.select().from(tasks).orderBy(tasks.id).all()).toEqual(before)
    expect(await createTaskOverviewQuery(harness.db).load({ actor, since: T0 })).toEqual(initial)
  })
})

interface Dispatch {
  readonly sql: string
  readonly parameters: readonly unknown[]
}
function createClientProbe(id: string) {
  const statements: Dispatch[] = []
  const stop = new Error(`w25-${id}-stopped-at-driver`)
  const closed = new Error(`w25-${id}-closed`)
  let closes = 0
  let reserves = 0
  const pool: PostgresqlPool = {
    unsafe(sql, parameters = []) {
      statements.push({ sql, parameters })
      throw closes === 0 ? stop : closed
    },
    async reserve() {
      reserves += 1
      throw new Error('unexpected-count-reservation')
    },
    async close() {
      closes += 1
    },
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_OVERVIEW_PROBE_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
    generationId: `dbg_w25_${id}`,
    env: { RFC359_OVERVIEW_PROBE_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => pool,
  })
  const previous = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(previous)
  return { db, runtime, statements, stop, closed, closes: () => closes, reserves: () => reserves }
}
async function expectCause(operation: PromiseLike<unknown>, expected: Error) {
  let observed: unknown
  try {
    await operation
  } catch (error) {
    observed = error
  }
  while (observed instanceof Error && observed.cause !== undefined) observed = observed.cause
  expect(observed).toBe(expected)
}

test('real client keeps every failed dispatch, fresh arrays and independent schema/runtime ownership', async () => {
  const first = createClientProbe('first')
  const other = createClientProbe('other')
  const owner = createTaskOverviewQuery(first.db)
  const previous = currentDatabaseSchemaProvider()
  const roots: SQL[] = []
  let previousRoots = new Set<SQL>()
  const originalCompile = SQLiteDialect.prototype.sqlToQuery
  const compile = spyOn(SQLiteDialect.prototype, 'sqlToQuery').mockImplementation(function (
    this: SQLiteDialect,
    query: SQL,
    source: Parameters<typeof originalCompile>[1],
  ) {
    const result = originalCompile.call(this, query, source)
    if (/^select count\(\*\) from /.test(result.sql)) roots.push(query)
    return result
  })
  try {
    for (const [index, provider] of ['postgresql', 'sqlite', 'postgresql'].entries()) {
      if (provider !== 'sqlite' && provider !== 'postgresql') throw new Error('invalid context')
      selectDatabaseSchemaProvider(provider)
      const start = first.statements.length
      const rootStart = roots.length
      await expectCause(owner.load({ actor, since: T0 + index }), first.stop)
      const retained = first.statements.slice(start)
      const currentRoots = roots.slice(rootStart)
      expect(retained).toHaveLength(4)
      expect(currentRoots).toHaveLength(4)
      for (const root of currentRoots) expect(previousRoots.has(root)).toBe(false)
      previousRoots = new Set(currentRoots)
      const referenceStart = first.statements.length
      await expectCause(
        createTaskOverviewQuery(first.db).load({ actor, since: T0 + index }),
        first.stop,
      )
      expect(retained).toEqual(first.statements.slice(referenceStart))
      expect(retained.map((statement) => statement.parameters)).toEqual([
        ['public', 'running'],
        ['public', 'awaiting_review', 'awaiting_human'],
        ['public', 'done', T0 + index],
        ['public', 'failed', T0 + index],
      ])
      for (let left = start; left < first.statements.length; left += 1) {
        for (let right = left + 1; right < first.statements.length; right += 1) {
          expect(first.statements[left]!.parameters).not.toBe(first.statements[right]!.parameters)
        }
      }
    }
    await first.runtime.close()
    expect(first.closes()).toBe(1)
    const beforeClosedRead = first.statements.length
    await expectCause(owner.load({ actor, since: T0 }), first.closed)
    expect(first.statements.length - beforeClosedRead).toBe(4)
    await expectCause(createTaskOverviewQuery(other.db).load({ actor, since: T0 }), other.stop)
    expect(other.statements).toHaveLength(4)
    expect(first.statements).toHaveLength(28)
    expect(first.reserves()).toBe(0)
    expect(other.reserves()).toBe(0)
  } finally {
    compile.mockRestore()
    selectDatabaseSchemaProvider(previous)
    await first.runtime.close()
    await other.runtime.close()
  }
})

test('a failed first SQL AST generation is not retained and retries preserve the original failure', async () => {
  const probe = createClientProbe('generation-failure')
  const restore = selectDatabaseSchemaProvider('postgresql')
  const original = SQLiteDialect.prototype.buildSelectQuery
  const firstFailure = new Error('w25-first-real-count-generation')
  let fail = true
  const generate = spyOn(SQLiteDialect.prototype, 'buildSelectQuery').mockImplementation(function (
    this: SQLiteDialect,
    input: Parameters<typeof original>[0],
  ) {
    if (fail && Object.keys(input.fields).join(',') === 'value') {
      fail = false
      throw firstFailure
    }
    return original.call(this, input)
  })
  try {
    const owner = createTaskOverviewQuery(probe.db)
    await expectCause(owner.load({ actor, since: T0 }), firstFailure)
    expect(probe.statements).toHaveLength(3)
    await expectCause(owner.load({ actor, since: T0 + 1 }), probe.stop)
    expect(probe.statements).toHaveLength(7)
    expect(probe.statements.slice(-4).map((statement) => statement.parameters)).toEqual([
      ['public', 'running'],
      ['public', 'awaiting_review', 'awaiting_human'],
      ['public', 'done', T0 + 1],
      ['public', 'failed', T0 + 1],
    ])
  } finally {
    generate.mockRestore()
    restore()
    await probe.runtime.close()
  }
})
