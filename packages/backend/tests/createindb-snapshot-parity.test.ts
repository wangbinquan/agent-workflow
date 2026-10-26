import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
// Template hydration must preserve the installed epoch-2 head and isolate every connection.
import { rawExec, rawRows } from '@/platform/persistence/queryHelpers'
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import { installHistoryHead } from '@/platform/persistence/schema/history/apply'
import { EPOCH2_SENTINEL } from '@/platform/persistence/schema/history/markers'

const opened: Database[] = []
function fresh() {
  const db = createInMemoryDb()
  opened.push(db.$client)
  return db
}
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})
const MASTER_QUERY =
  "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
function schemaFingerprint(rows: unknown[][]): string {
  return rows
    .map((row) => `${String(row[0])}\t${String(row[1] ?? '')}`)
    .sort()
    .join('\n')
}

describe('createInMemoryDb snapshot parity', () => {
  test('hydrated schema is identical to a freshly installed head', async () => {
    const control = new Database(':memory:')
    opened.push(control)
    await installHistoryHead(sqliteHistorySession(control), {
      version: persistenceHead(),
      generationId: 'dbg_control',
      installPath: 'test-baseline',
      metaTables: EPOCH2_META_TABLES,
      now: () => 0,
    })
    const controlRows = control.query(MASTER_QUERY).values()
    const hydrated = fresh()
    const hydratedRows = rawRows(hydrated, sql.raw(MASTER_QUERY)).map(Object.values)
    expect(controlRows.length).toBeGreaterThanOrEqual(persistenceSchema.tables.length + 21)
    expect(schemaFingerprint(hydratedRows)).toBe(schemaFingerprint(controlRows))
  })

  test('head receipt, sentinel, install-only seeds and one active generation survive hydration', () => {
    const db = fresh()
    const head = persistenceHead()
    expect(rawRows(db, sql`SELECT hash FROM __drizzle_migrations`)).toEqual([
      { hash: EPOCH2_SENTINEL },
    ])
    const receipts = rawRows<{ artifact_json: string; contract_digest: string }>(
      db,
      sql`SELECT artifact_json, contract_digest FROM aw_meta_schema_history`,
    )
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.contract_digest).toBe(head.contract.contract.digest)
    expect(JSON.parse(receipts[0]!.artifact_json)).toEqual(head)
    expect(rawRows(db, sql`SELECT schema_epoch, role, state FROM aw_meta_generations`)).toEqual([
      { schema_epoch: 2, role: 'installed', state: 'active' },
    ])
    expect(rawRows(db, sql`SELECT id FROM users`)).toContainEqual({ id: '__system__' })
    expect(rawRows(db, sql`SELECT bootstrap_completed_at FROM auth_login_policy`)).toEqual([
      { bootstrap_completed_at: 0 },
    ])
  })

  test('foreign-key enforcement is ON on every hydrated connection', () => {
    const db = fresh()
    expect(rawRows(db, sql.raw('PRAGMA foreign_keys'))).toEqual([{ foreign_keys: 1 }])
    expect(rawRows(db, sql.raw('PRAGMA foreign_key_check'))).toEqual([])
  })

  test('instances isolate both DDL and seed mutations from each other and the cached template', () => {
    const a = fresh()
    const b = fresh()
    rawExec(a, sql.raw('CREATE TABLE __isolation_probe (x integer)'))
    rawExec(a, sql`UPDATE auth_login_policy SET bootstrap_completed_at = 123`)
    expect(
      rawRows(b, sql`SELECT name FROM sqlite_master WHERE name = '__isolation_probe'`),
    ).toEqual([])
    expect(
      rawRows(a, sql`SELECT name FROM sqlite_master WHERE name = '__isolation_probe'`),
    ).toHaveLength(1)
    expect(rawRows(a, sql`SELECT bootstrap_completed_at FROM auth_login_policy`)).toEqual([
      { bootstrap_completed_at: 123 },
    ])
    for (const db of [b, fresh()]) {
      expect(
        rawRows(db, sql`SELECT name FROM sqlite_master WHERE name = '__isolation_probe'`),
      ).toEqual([])
      expect(rawRows(db, sql`SELECT bootstrap_completed_at FROM auth_login_policy`)).toEqual([
        { bootstrap_completed_at: 0 },
      ])
    }
    const required = createInMemoryDb({ bootstrap: 'required' })
    opened.push(required.$client)
    expect(rawRows(required, sql`SELECT bootstrap_completed_at FROM auth_login_policy`)).toEqual([
      { bootstrap_completed_at: null },
    ])
  })
})
