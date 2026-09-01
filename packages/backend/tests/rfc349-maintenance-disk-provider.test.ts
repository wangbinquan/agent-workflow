import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import {
  composePostgresqlMaintenanceDiskOperations,
  composeSqliteMaintenanceDiskOperations,
} from '@/modules/system-operations/composition/maintenanceDisk'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

describe('RFC-349 maintenance disk provider operations', () => {
  test('SQLite reports freelist pages through its provider adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-maintenance-disk-sqlite-'))
    roots.push(root)
    const native = new Database(join(root, 'db.sqlite'))
    native.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY);')
    const operations = composeSqliteMaintenanceDiskOperations(drizzle(native), root)

    expect(await operations.report()).toMatchObject({
      items: [{ id: 'retired-runtime-stores', exists: false }],
      dbFreelistBytes: 0,
    })
    native.close()
  })

  test('PostgreSQL reports catalog storage and never emits SQLite mechanisms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc349-maintenance-disk-postgresql-'))
    roots.push(root)
    const retired = join(root, 'opencode-stores')
    mkdirSync(retired)
    writeFileSync(join(retired, 'stale.bin'), 'fixture')
    const statements: string[] = []
    const pool = {
      unsafe(sql: string): SqlRows {
        statements.push(sql)
        return rows([{ database_bytes: '4096', reclaimable_bytes: '512' }])
      },
    } as PostgresqlPool
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_postgresql_maintenance_disk',
      providerPool: () => pool,
    } as PostgresqlDatabaseRuntime
    const operations = composePostgresqlMaintenanceDiskOperations(runtime, root)

    expect(await operations.report()).toMatchObject({
      items: [{ id: 'retired-runtime-stores', exists: true, bytes: 7, entries: 1 }],
      dbFreelistBytes: 512,
      dbFileBytes: 4096,
    })
    expect(statements.join('\n')).toContain('pg_stat_user_tables')
    expect(statements.join('\n')).not.toMatch(/PRAGMA|bun:sqlite|db\.sqlite/i)
    expect(await operations.cleanupRetiredStores()).toEqual({ removedBytes: 7 })
  })
})
