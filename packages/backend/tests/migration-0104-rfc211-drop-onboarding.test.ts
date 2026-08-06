// RFC-211 §12 reversal — migration 0104 removes the example sandbox.
//
// 0103 added five `example` columns + two onboarding tables; the sandbox they
// backed was replaced by the hand-holding spotlight tour (which builds the
// user's own real resources, no example concept), so 0104 drops all of it. This
// locks the removal: the columns are gone, the tables are gone, and the tables
// the columns lived on are otherwise intact.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'
import { removeTempDirSync } from './fixtures/tempDir'

function withMigratedDb<T>(fn: (raw: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig-0104-'))
  const dbPath = join(dir, 'test.db')
  try {
    // RFC-254: capture and close the openDb (drizzle) handle — a discarded
    // return leaks it, and on Windows bun:sqlite frees the OS handle on GC, not
    // close(), so the leaked + raw handles keep the dir busy at rm time.
    const client = openDb({
      path: dbPath,
      migrationsFolder: join(import.meta.dir, '..', 'db', 'migrations'),
    })
    const raw = new Database(dbPath, { readwrite: true })
    try {
      return fn(raw)
    } finally {
      raw.close()
      ;(client as unknown as { $client: Database }).$client.close()
    }
  } finally {
    // GCs first so the just-closed (GC-gated on Windows) handles are released.
    removeTempDirSync(dir)
  }
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

describe('migration 0104 — RFC-211 example sandbox removed', () => {
  test('the example column is gone from all five business tables', () => {
    withMigratedDb((db) => {
      for (const table of ['agents', 'skills', 'workflows', 'workgroups', 'tasks']) {
        expect({ table, hasExample: columnNames(db, table).has('example') }).toEqual({
          table,
          hasExample: false,
        })
      }
    })
  })

  test('those tables still exist and kept their identity columns', () => {
    withMigratedDb((db) => {
      // A DROP COLUMN that took the whole table with it would show up here.
      expect(columnNames(db, 'agents').has('name')).toBe(true)
      expect(columnNames(db, 'tasks').has('status')).toBe(true)
      expect(columnNames(db, 'workflows').has('definition')).toBe(true)
    })
  })

  test('the onboarding bookkeeping tables are dropped', () => {
    withMigratedDb((db) => {
      const tables = new Set(
        (
          db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{
            name: string
          }>
        ).map((r) => r.name),
      )
      expect(tables.has('onboarding_runs')).toBe(false)
      expect(tables.has('onboarding_artifacts')).toBe(false)
    })
  })
})
