// RFC-395 I-b: both native table projections must satisfy the same semantic row and insert types.
import type { TableDefinition } from '@/platform/persistence/schema/contribution'
import { describe, expect, test } from 'bun:test'
import {
  getTableColumns,
  getTableName,
  is,
  type InferInsertModel,
  type InferSelectModel,
} from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { column as c, defineContribution, retention } from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import type { NeutralTable, NeutralTableSet } from '@/platform/persistence/schema/neutral'

const definition = defineContribution('example').table({
  id: 'neutral_examples',
  schemaSymbol: 'examples',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    createdAt: c.epochMs('created_at'),
    archived: c.bool('archived', { default: false }),
    note: c.text('note', { nullable: true }),
    state: c.enum('state', ['ready', 'done'], { default: 'ready' }),
    bytes: c.bytes('bytes', { nullable: true }),
    sequence: c.bigint('sequence', { nullable: true }),
  },
})
const native = materializeDrizzle(definition)
const sqlite: NeutralTable<typeof definition> = native.sqlite
const postgresql: NeutralTable<typeof definition> = native.postgresql
const tables: NeutralTableSet<readonly [typeof definition]> = { examples: postgresql }
type Row = InferSelectModel<NeutralTable<typeof definition>>
type Insert = InferInsertModel<NeutralTable<typeof definition>>
const minimal: Insert = { id: 'one', createdAt: 100 }
const row: Row = {
  id: 'one',
  createdAt: 100,
  archived: false,
  note: null,
  state: 'ready',
  bytes: null,
  sequence: 1n,
}

// Negative controls are compiled by the backend typecheck, including omitted/defaulted columns.
// @ts-expect-error createdAt is required and has no default
const missingRequired: Insert = { id: 'one' }
// @ts-expect-error epoch milliseconds are numbers, not strings
const wrongTime: Insert = { id: 'one', createdAt: '100' }
// @ts-expect-error a nullable note is not a non-null string
const nonNullNote: string = row.note
// @ts-expect-error enums keep their literal union
const wrongState: Insert = { id: 'one', createdAt: 100, state: 'unknown' }
const wrongDefinition = defineContribution('example').table({
  ...definition,
  columns: { ...definition.columns, createdAt: c.text('created_at') },
})
// @ts-expect-error a string column cannot stand in for an epoch-ms column
const wrongSqlite: NeutralTable<typeof definition> = materializeDrizzle(wrongDefinition).sqlite
// @ts-expect-error the same mismatch must be rejected on PostgreSQL
const wrongPostgresql: NeutralTable<typeof definition> =
  materializeDrizzle(wrongDefinition).postgresql

describe('RFC-395 I-b native tables and neutral semantics', () => {
  test('the neutral view preserves each native table object', () => {
    expect(sqlite).toBe(native.sqlite)
    expect(postgresql).toBe(native.postgresql)
    expect(is(sqlite, SQLiteTable)).toBe(true)
    expect(is(postgresql, PgTable)).toBe(true)
    expect(tables.examples).toBe(postgresql)
    expect(getTableName(sqlite)).toBe('neutral_examples')
    expect(getTableName(postgresql)).toBe('neutral_examples')
    expect(minimal).toEqual({ id: 'one', createdAt: 100 })
    expect(row.archived).toBe(false)
  })
  test('negative type controls retain the incompatible values instead of coercing them', () => {
    expect(missingRequired.createdAt).toBeUndefined()
    expect<unknown>(wrongTime.createdAt).toBe('100')
    expect(nonNullNote).toBeNull()
    expect<unknown>(wrongState.state).toBe('unknown')
    expect(wrongSqlite.createdAt.dataType).toBe('string')
    expect(wrongPostgresql.createdAt.dataType).toBe('string')
  })
  test('every current contribution keeps matching physical column names and nullability', () => {
    for (const table of persistenceSchema.tables as readonly TableDefinition[]) {
      const pair = materializeDrizzle(table)
      const sqliteColumns = getTableColumns(pair.sqlite)
      const pgColumns = getTableColumns(pair.postgresql)
      expect(Object.keys(sqliteColumns)).toEqual(Object.keys(table.columns))
      expect(Object.keys(pgColumns)).toEqual(Object.keys(table.columns))
      for (const [property, column] of Object.entries(table.columns)) {
        expect(sqliteColumns[property]!.name).toBe(column.name)
        expect(pgColumns[property]!.name).toBe(column.name)
        expect(sqliteColumns[property]!.notNull).toBe(!column.nullable)
        expect(pgColumns[property]!.notNull).toBe(!column.nullable)
      }
    }
  })
})
