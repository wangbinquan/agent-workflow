import '@/bootstrap/persistenceSchema'
// RFC-359 W22 — SQL text reuse must preserve the original token projection,
// fresh Drizzle bindings and every actual client dispatch. These are pure
// compilation checks; the client probe stops at the driver without executing SQL.

import { rawRows, rawFirst, rawExec, queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
function selectedValue(value: unknown) {
  return sql.join([sql.raw('select '), sql.param(value), sql.raw(' as value')], sql.raw(''))
}

interface CapturedStatement {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

function createCompilationProbe() {
  const statements: CapturedStatement[] = []
  const stop = new Error('compiler-probe-stopped-before-driver-execution')
  let closeCount = 0
  let reserveCount = 0
  const pool: PostgresqlPool = {
    unsafe(query, parameters = []) {
      // Retain the actual parameter array identity: copying it here would hide
      // an incorrect reuse of mutable binding state between calls.
      statements.push({ sql: query, parameters })
      throw stop
    },
    async reserve() {
      reserveCount += 1
      throw new Error('compiler-probe-unexpected-reservation')
    },
    async close() {
      closeCount += 1
    },
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: {
      provider: 'postgresql',
      urlEnv: 'RFC359_COMPILE_REUSE_URL',
      poolMax: 1,
      connectTimeoutMs: 1_000,
      statementTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    },
    generationId: 'dbg_rfc359_compile_reuse',
    env: { RFC359_COMPILE_REUSE_URL: 'postgresql://fixture:fixture@localhost/fixture' },
    poolFactory: () => pool,
  })
  const db = createPostgresqlDatabaseClient(runtime)
  return {
    db,
    runtime,
    statements,
    stop,
    closeCount: () => closeCount,
    reserveCount: () => reserveCount,
  }
}

async function expectStopped(operation: unknown, stop: Error): Promise<void> {
  let observed: unknown
  try {
    await operation
  } catch (error) {
    observed = error
  }
  // Drizzle builders wrap the driver error; raw queries preserve it directly.
  while (observed instanceof Error && observed.cause !== undefined) observed = observed.cause
  expect(observed).toBe(stop)
}

describe('RFC-359 W22 PostgreSQL SQL text reuse', () => {
  test('native rendering creates independent bindings for repeated and large SQL', () => {
    const dialect = new PgDialect()
    const values = [0, 'opaque value', '?', null, false, new Date('2000-01-01T00:00:00.000Z')]
    const queries = values.map((value) => dialect.sqlToQuery(selectedValue(value)))
    for (const [index, query] of queries.entries()) {
      expect(query.sql).toBe('select $1 as value')
      expect(query.params).toEqual([values[index]])
      if (index) expect(query.params).not.toBe(queries[index - 1]!.params)
    }
    for (const length of [262_144, 262_145]) {
      const text = "select '" + 'x'.repeat(length - 9) + "'"
      for (let repeat = 0; repeat < 2; repeat++)
        expect(dialect.sqlToQuery(sql.raw(text)).sql).toBe(text)
    }
    for (let index = 0; index < 257; index++) {
      const suffix = ' /* entry-' + index + ' 😀 */'
      expect(dialect.sqlToQuery(sql`select ${index}${sql.raw(suffix)}`).sql).toBe(
        'select $1' + suffix,
      )
    }
  })

  test('dispatches every raw method with fresh bindings in the original driver order', async () => {
    const probe = createCompilationProbe()
    try {
      const values = [17, 'opaque value', null, false]
      const dispatch = {
        all: (query: ReturnType<typeof selectedValue>) => rawRows(probe.db, query),
        get: (query: ReturnType<typeof selectedValue>) => rawFirst(probe.db, query),
        values: (query: ReturnType<typeof selectedValue>) =>
          Promise.resolve(rawRows(probe.db, query)).then((rows) =>
            rows.map((row) => Object.values(row)),
          ),
        run: (query: ReturnType<typeof selectedValue>) => rawExec(probe.db, query),
      }
      for (const method of ['all', 'get', 'values', 'run'] as const) {
        for (const value of values) {
          await expectStopped(dispatch[method](selectedValue(value)), probe.stop)
        }
      }
      expect(probe.statements).toHaveLength(16)
      expect(probe.statements.map((statement) => statement.sql)).toEqual(
        Array.from({ length: 16 }, () => 'select $1 as value'),
      )
      expect(probe.statements.map((statement) => statement.parameters)).toEqual(
        Array.from({ length: 4 }, () => values.map((value) => [value])).flat(),
      )
      for (let index = 1; index < probe.statements.length; index += 1) {
        expect(probe.statements[index]?.parameters).not.toBe(
          probe.statements[index - 1]?.parameters,
        )
      }
      expect(probe.reserveCount()).toBe(0)
    } finally {
      await probe.runtime.close()
    }
    expect(probe.closeCount()).toBe(1)
  })

  test('reuses one actual builder with independent placeholder values on every driver call', async () => {
    const probe = createCompilationProbe()
    try {
      const query = probe.db
        .select({ value: sql.join([sql.placeholder('value')], sql.raw('')).as('value') })
        .from(sql.raw('(select 1) as compiler_source'))
      const values = [0, 'opaque value', '?', null, false]
      for (const value of values) await expectStopped(queryRows(query, { value }), probe.stop)
      expect(query.toSQL().sql).toBe('select $1 as "value" from (select 1) as compiler_source')
      expect(probe.statements.map((statement) => statement.sql)).toEqual(
        values.map(() => 'select $1 as "value" from (select 1) as compiler_source'),
      )
      expect(probe.statements.map((statement) => statement.parameters)).toEqual(
        values.map((value) => [value]),
      )
      for (let index = 1; index < values.length; index += 1) {
        expect(probe.statements[index]?.parameters).not.toBe(
          probe.statements[index - 1]?.parameters,
        )
      }
      expect(probe.reserveCount()).toBe(0)
    } finally {
      await probe.runtime.close()
    }
    expect(probe.closeCount()).toBe(1)
  })

  test('regenerates the actual client SQL after mutating the same SQL object', async () => {
    const probe = createCompilationProbe()
    try {
      const query = sql.join([sql.raw('select '), sql.param(1)], sql.raw(''))
      await expectStopped(rawRows(probe.db, query), probe.stop)
      query.append(sql.join([sql.raw(' + '), sql.param(2)], sql.raw('')))
      await expectStopped(rawRows(probe.db, query), probe.stop)
      expect(probe.statements).toEqual([
        { sql: 'select $1', parameters: [1] },
        { sql: 'select $1 + $2', parameters: [1, 2] },
      ])
      expect(probe.statements[1]?.parameters).not.toBe(probe.statements[0]?.parameters)
      expect(probe.reserveCount()).toBe(0)
    } finally {
      await probe.runtime.close()
    }
    expect(probe.closeCount()).toBe(1)
  })
})
