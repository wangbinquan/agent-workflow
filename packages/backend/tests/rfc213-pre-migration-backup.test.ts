// RFC-213 PR-3 — pre-migration safety backup.
//
// design/RFC-213-disaster-recovery/design.md §6.3 / §7 #8: before boot migrations,
// if the DB is BEHIND the binary (its newest __drizzle_migrations.created_at is
// older than the binary's newest _journal.json `when`), raw-copy the DB so a
// botched upgrade is recoverable. It uses rawCopyDb (byte copy), NOT createBackup
// — the OLD schema can't be SELECTed by the NEW binary.
//
// MUTATION CHECK (manually verified): remove the `dbMax >= binaryMax` pending
// check → an up-to-date DB also gets backed up → the "no pending → null" test reds.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../src/db/client'
import { maybePreMigrationBackup } from '../src/services/backupScheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-premig-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

describe('maybePreMigrationBackup', () => {
  test('fully-migrated DB (up to date) → no backup', async () => {
    const home = tmp()
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    sqliteOf(db).close()

    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
      migrationsFolder: MIGRATIONS,
      enabled: true,
      now: 1,
    })
    expect(r).toBeNull()
  })

  test('DB behind the binary → raw pre-migration backup', async () => {
    const home = tmp()
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    // Forge "behind": drop the newest applied migration row so the DB's max
    // created_at is older than the binary's journal max.
    const s = sqliteOf(db)
    s.exec(
      'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
    )
    s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    s.close()

    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
      migrationsFolder: MIGRATIONS,
      enabled: true,
      now: 1,
    })
    expect(r).not.toBeNull()
    expect(existsSync(r!)).toBe(true)
    const files = readdirSync(join(home, 'backups'))
    expect(files.some((f) => f.startsWith('pre-migration-'))).toBe(true)
  })

  test('enabled=false → no backup even when behind', async () => {
    const home = tmp()
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const s = sqliteOf(db)
    s.exec(
      'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
    )
    s.close()
    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
      migrationsFolder: MIGRATIONS,
      enabled: false,
      now: 1,
    })
    expect(r).toBeNull()
  })

  test('fresh install (no DB file) → no backup', async () => {
    const home = tmp()
    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      enabled: true,
      now: 1,
    })
    expect(r).toBeNull()
  })
})
