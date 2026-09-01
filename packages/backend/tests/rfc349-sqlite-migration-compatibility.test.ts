// RFC-349 compiled-macOS regression: supported hosts can expose SQLite older
// than 3.44, where ORDER BY inside json_group_array(...) is a syntax error.
// Historical migration bytes remain immutable; the single executor must
// preserve their receipts while using the ordered-subquery equivalent.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { resolve } from 'node:path'
import { migrateSqlite, rewriteLegacyOrderedJsonAggregates } from '../src/db/sqliteMigrator'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-349 SQLite migration compatibility', () => {
  test('rewrites every historical ordered JSON aggregate without changing migration files', () => {
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS })
    const sourceStatements = migrations.flatMap((migration) => migration.sql)
    const affected = sourceStatements.filter((statement) =>
      /SELECT json_group_array\(\n[\s\S]*?\n[ \t]+ORDER BY [^\n]+\n[ \t]*\)\n[ \t]*FROM json_each\([^\n]+\) AS [^\s;\n]+/u.test(
        statement,
      ),
    )
    const rewritten = affected.map(rewriteLegacyOrderedJsonAggregates)

    expect(affected).toHaveLength(12)
    expect(rewritten.every((statement) => !statement.includes('ORDER BY node.key\n    )'))).toBe(
      true,
    )
    expect(rewritten.every((statement) => statement.includes('__aw_ordered_json_'))).toBe(true)
  })

  test('ordered-subquery form preserves array order and nested JSON values', () => {
    const sqlite = new Database(':memory:')
    try {
      const source = `
        SELECT json_group_array(
          json(value)
          ORDER BY key
        )
        FROM json_each('[{"id":"b"},{"id":"a"}]') AS item
      `
        .replace('json(value)', 'json(item.value)')
        .replace('ORDER BY key', 'ORDER BY item.key')
      const rewritten = rewriteLegacyOrderedJsonAggregates(source)
      const row = sqlite.query(rewritten).get() as { [key: string]: string }
      const payload = Object.values(row)[0]

      expect(JSON.parse(payload!)).toEqual([{ id: 'b' }, { id: 'a' }])
    } finally {
      sqlite.close()
    }
  })

  test('full fresh replay succeeds through the compatibility executor with canonical hashes', () => {
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = OFF')
      migrateSqlite(
        sqlite,
        { migrationsFolder: MIGRATIONS },
        { orderedJsonAggregateSupport: false },
      )
      const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS })
      const receipts = sqlite
        .query('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC')
        .all() as Array<{ hash: string; created_at: number }>

      expect(receipts).toHaveLength(expected.length)
      expect(receipts.map((receipt) => receipt.hash)).toEqual(
        expected.map((migration) => migration.hash),
      )
    } finally {
      sqlite.close()
    }
  })
})
