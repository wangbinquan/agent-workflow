// RFC-359 W22 — SQL text reuse must preserve the original token projection,
// fresh Drizzle bindings and every actual client dispatch. These are pure
// compilation checks; the client probe stops at the driver without executing SQL.

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import {
  compilePostgresqlSql,
  PostgresqlSqlCompatibilityError,
} from '@/platform/persistence/postgresqlSql'

const TRANSLATIONS = [
  ['', ''],
  ['select ?', 'select $1'],
  ['select ?, ?, ?', 'select $1, $2, $3'],
  ["select '?', ?, 'it''s ?'", "select '?', $1, 'it''s ?'"],
  ['select "?", ?, "a""?"', 'select "?", $1, "a""?"'],
  ['select $$?$$, $tag$?$tag$, ?', 'select $$?$$, $tag$?$tag$, $1'],
  ['select ? -- ?\n, ? /* ? */', 'select $1 -- ?\n, $2 /* ? */'],
  [
    'select "one"."x" from "one"."t" where "x" = ?',
    'select "one"."x" from "one"."t" where "x" = $1',
  ],
  [
    'select "two"."x" from "two"."t" where "x" = ?',
    'select "two"."x" from "two"."t" where "x" = $1',
  ],
  ['select ? as "名😀"', 'select $1 as "名😀"'],
  [
    'insert into "one"."t" ("id", "name") values (?, ?) on conflict ("one"."t"."id") do update set "name" = ?',
    'insert into "one"."t" ("id", "name") values ($1, $2) on conflict ("id") do update set "name" = $3',
  ],
] as const

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
  const provider = currentDatabaseSchemaProvider()
  const db = createPostgresqlDatabaseClient(runtime)
  selectDatabaseSchemaProvider(provider)
  return {
    db,
    runtime,
    statements,
    stop,
    closeCount: () => closeCount,
    reserveCount: () => reserveCount,
  }
}

async function expectStopped(operation: PromiseLike<unknown>, stop: Error): Promise<void> {
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
  test('preserves exact token and conflict projections across repeated interleaved strings', () => {
    for (const sequence of [TRANSLATIONS, [...TRANSLATIONS].reverse(), TRANSLATIONS]) {
      for (const [input, expected] of sequence) expect(compilePostgresqlSql(input)).toBe(expected)
    }
    expect(compilePostgresqlSql('select ' + Array.from({ length: 12 }, () => '?').join(', '))).toBe(
      'select ' + Array.from({ length: 12 }, (_, index) => '$' + (index + 1)).join(', '),
    )
  })

  test('keeps fresh dialect arrays and exact values when the SQL text is shared', () => {
    const dialect = new SQLiteAsyncDialect()
    const values = [0, 'opaque value', '?', null, false, new Date('2000-01-01T00:00:00.000Z')]
    const queries = values.map((value) => dialect.sqlToQuery(selectedValue(value)))
    for (const [index, query] of queries.entries()) {
      expect(query.sql).toBe('select ? as value')
      expect(compilePostgresqlSql(query.sql)).toBe('select $1 as value')
      expect(query.params).toHaveLength(1)
      expect(query.params[0]).toBe(values[index])
      if (index > 0) expect(query.params).not.toBe(queries[index - 1]?.params)
    }
  })

  test('keeps output unchanged after entry pressure and oversized or multicode-unit strings', () => {
    for (let index = 0; index < 257; index += 1) {
      expect(compilePostgresqlSql('select ? /* entry-' + index + ' */')).toBe(
        'select $1 /* entry-' + index + ' */',
      )
    }
    expect(compilePostgresqlSql('select ? /* entry-0 */')).toBe('select $1 /* entry-0 */')
    const exactLimit = "select '" + 'x'.repeat(262_144 - 9) + "'"
    expect(exactLimit.length).toBe(262_144)
    expect(compilePostgresqlSql(exactLimit)).toBe(exactLimit)
    expect(compilePostgresqlSql(exactLimit)).toBe(exactLimit)
    const oversized = "select '" + 'x'.repeat(262_145 - 9) + "'"
    expect(compilePostgresqlSql(oversized)).toBe(oversized)
    expect(compilePostgresqlSql(oversized)).toBe(oversized)
    for (let index = 0; index < 3; index += 1) {
      const suffix = ' /* units-' + index + ' ' + '😀'.repeat(45_000) + ' */'
      expect(compilePostgresqlSql('select ?' + suffix)).toBe('select $1' + suffix)
    }
    expect(compilePostgresqlSql('')).toBe('')
    expect(compilePostgresqlSql('')).toBe('')
  })

  test('creates the original parse error afresh for each repeated malformed token', () => {
    for (const [input, message] of [
      ["select 'broken ?", 'unterminated quoted SQL token'],
      ['select /* broken ?', 'unterminated SQL block comment'],
      ['select $tag$ broken ?', 'unterminated PostgreSQL dollar-quoted SQL token'],
    ] as const) {
      const errors: PostgresqlSqlCompatibilityError[] = []
      for (let repeat = 0; repeat < 2; repeat += 1) {
        try {
          compilePostgresqlSql(input)
        } catch (error) {
          expect(error).toBeInstanceOf(PostgresqlSqlCompatibilityError)
          if (!(error instanceof PostgresqlSqlCompatibilityError)) throw error
          expect(error.code).toBe('unterminated-sql-token')
          expect(error.message).toBe(message)
          errors.push(error)
        }
      }
      expect(errors).toHaveLength(2)
      expect(errors[1]).not.toBe(errors[0])
    }
  })

  test('dispatches every raw method with fresh bindings in the original driver order', async () => {
    const probe = createCompilationProbe()
    try {
      const values = [17, 'opaque value', null, false]
      const dispatch = {
        all: (query: ReturnType<typeof selectedValue>) => probe.db.all(query),
        get: (query: ReturnType<typeof selectedValue>) => probe.db.get(query),
        values: (query: ReturnType<typeof selectedValue>) => probe.db.values(query),
        run: (query: ReturnType<typeof selectedValue>) => probe.db.run(query),
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
      for (const value of values) await expectStopped(query.all({ value }), probe.stop)
      expect(query.toSQL().sql).toBe('select ? as "value" from (select 1) as compiler_source')
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
      await expectStopped(probe.db.all(query), probe.stop)
      query.append(sql.join([sql.raw(' + '), sql.param(2)], sql.raw('')))
      await expectStopped(probe.db.all(query), probe.stop)
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
