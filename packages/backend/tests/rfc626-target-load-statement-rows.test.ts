// RFC-626 §4.6 "写新库" (design §7 "PostgreSQL：各多行写入点的批大小不超过参数上限"): loading
// the new database binds rows × columns parameters per INSERT. PostgreSQL takes up to 30,000
// parameters and 1,000 rows a statement (`tasks`, 70 columns, 428 rows instead of 12); SQLite
// keeps its earlier limits (900 parameters, 100 rows). A fake connection records the statements,
// so these cases need no database: every statement stays within its limit, carries the expected
// number of rows, numbers its placeholders consecutively and binds the rows in order.
import { expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  createTargetLoader,
  targetStatementRows,
} from '@/platform/persistence/migration/target/loader'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { HistoryConnection } from '@/platform/persistence/schema/history/connection'

interface Statement {
  readonly sql: string
  readonly values: readonly unknown[]
}
function recorder(provider: DatabaseProvider): {
  readonly tx: HistoryConnection
  readonly statements: Statement[]
} {
  const statements: Statement[] = []
  return {
    statements,
    tx: {
      provider,
      async execute(sql, values = []) {
        statements.push({ sql, values: [...values] })
        return []
      },
    },
  }
}

/** The limits RFC-626 §4.6 states, restated independently of the implementation. */
const LIMITS = {
  postgresql: { parameters: 30_000, rows: 1_000 },
  sqlite: { parameters: 900, rows: 100 },
} as const
const statementRows = (provider: DatabaseProvider, width: number) =>
  Math.min(LIMITS[provider].rows, Math.max(1, Math.floor(LIMITS[provider].parameters / width)))

const widest = [...persistenceSchema.tables].sort(
  (a, b) => Object.keys(b.columns).length - Object.keys(a.columns).length,
)[0]!
const widestColumns = Object.values(widest.columns).map((column) => column.name)
// Codecs the loader binds unchanged, so bound values can be compared with the rows.
const plain = Object.values(widest.columns)
  .filter((column) => !['bool', 'bigint', 'bytes', 'real'].includes(column.codec))
  .map((column) => column.name)
const nullRows = (count: number, names: readonly string[]): TargetRow[] =>
  Array.from({ length: count }, () => Object.fromEntries(names.map((name) => [name, null])))

function placeholders(provider: DatabaseProvider, sql: string): number[] {
  if (provider === 'sqlite') return [...sql.matchAll(/\?/gu)].map((_, index) => index + 1)
  return [...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))
}

function expectStatements(
  provider: DatabaseProvider,
  statements: readonly Statement[],
  width: number,
  total: number,
  perStatement = statementRows(provider, width),
) {
  const rows = statements.map((statement) => statement.values.length / width)
  expect(rows.reduce((sum, count) => sum + count, 0)).toBe(total)
  expect(rows.slice(0, -1).every((count) => count === perStatement)).toBe(true)
  expect(rows.at(-1)).toBe(total % perStatement || perStatement)
  for (const statement of statements) {
    expect(statement.sql.startsWith('INSERT INTO ')).toBe(true)
    expect(statement.values.length).toBeLessThanOrEqual(LIMITS[provider].parameters)
    expect(statement.values.length / width).toBeLessThanOrEqual(LIMITS[provider].rows)
    expect(placeholders(provider, statement.sql)).toEqual(
      Array.from({ length: statement.values.length }, (_, index) => index + 1),
    )
  }
}

test('statement rows follow the stated limit per database', () => {
  expect(targetStatementRows('postgresql', 70)).toBe(428)
  expect(targetStatementRows('postgresql', 16)).toBe(1_000)
  expect(targetStatementRows('postgresql', 30)).toBe(1_000)
  expect(targetStatementRows('postgresql', 31)).toBe(967)
  expect(targetStatementRows('postgresql', 40_000)).toBe(1)
  expect(targetStatementRows('sqlite', 70)).toBe(12)
  expect(targetStatementRows('sqlite', 9)).toBe(100)
  expect(targetStatementRows('sqlite', 10)).toBe(90)
  expect(targetStatementRows('sqlite', 1_000)).toBe(1)
  expect(targetStatementRows('postgresql', 2, 7)).toBe(7)
  expect(targetStatementRows('sqlite', 2, 7)).toBe(7)
  expect(targetStatementRows('postgresql', 70, 5_000)).toBe(428)
  for (const provider of ['sqlite', 'postgresql'] as const)
    for (let width = 1; width <= 2_000; width += 1)
      expect(targetStatementRows(provider, width)).toBe(statementRows(provider, width))
})

for (const provider of ['postgresql', 'sqlite'] as const) {
  test(`${provider}: the widest target table loads within the parameter limit`, async () => {
    const width = widestColumns.length
    const perStatement = statementRows(provider, width)
    const total = perStatement * 2 + 3
    const { tx, statements } = recorder(provider)
    const loader = createTargetLoader({ registry: persistenceSchema, provider })
    await loader.insert(tx, [{ table: widest.id, rows: nullRows(total, widestColumns) }])
    expect(statements).toHaveLength(3)
    expectStatements(provider, statements, width, total)
  })

  test(`${provider}: narrow rows load ${LIMITS[provider].rows} a statement and bind in row order`, async () => {
    const names = plain.slice(0, 2)
    expect(names).toHaveLength(2)
    const total = 2_500
    const rows: TargetRow[] = Array.from({ length: total }, (_, index) =>
      Object.fromEntries(names.map((name) => [name, `${name}-${index}`])),
    )
    const { tx, statements } = recorder(provider)
    await createTargetLoader({ registry: persistenceSchema, provider }).insert(tx, [
      { table: widest.id, rows },
    ])
    expect(statements).toHaveLength(Math.ceil(total / LIMITS[provider].rows))
    expectStatements(provider, statements, 2, total, LIMITS[provider].rows)
    // Columns bind in table-definition order, rows in input order.
    const ordered = widestColumns.filter((name) => names.includes(name))
    expect(statements.flatMap((statement) => statement.values)).toEqual(
      rows.flatMap((row) => ordered.map((name) => row[name])),
    )
  })

  test(`${provider}: an explicit batch size still caps a statement`, async () => {
    const { tx, statements } = recorder(provider)
    await createTargetLoader({ registry: persistenceSchema, provider, batchRows: 7 }).insert(tx, [
      { table: widest.id, rows: nullRows(30, plain.slice(0, 2)) },
    ])
    expectStatements(provider, statements, 2, 30, 7)
    for (const batchRows of [0, 1.5, -1])
      expect(() =>
        createTargetLoader({ registry: persistenceSchema, provider, batchRows }),
      ).toThrow('v3-loader-batch-rows')
  })
}

test('a 1,000-row and a 2,000-row load of a wide table stay within the PostgreSQL limit', async () => {
  for (const total of [1_000, 2_000]) {
    const { tx, statements } = recorder('postgresql')
    await createTargetLoader({ registry: persistenceSchema, provider: 'postgresql' }).insert(tx, [
      { table: widest.id, rows: nullRows(total, widestColumns) },
    ])
    expectStatements('postgresql', statements, widestColumns.length, total)
  }
})
