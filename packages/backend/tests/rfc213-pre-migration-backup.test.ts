// RFC-213 PR-3 — pre-migration safety backup.
//
// design/RFC-213-disaster-recovery/design.md §6.3 / §7 #8: before boot migrations,
// if the native epoch-2 history is BEHIND the binary, raw-copy the DB so a
// botched upgrade is recoverable. It uses rawCopyDb (byte copy), NOT createBackup
// — the OLD schema can't be SELECTed by the NEW binary.
//
// The regression cases distinguish no-op, disabled and pending history paths.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { removeTempDirSync } from './fixtures/tempDir'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DbClient } from '@/db/client'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import {
  registerSchemaHistoryRuntime,
  schemaHistoryRuntime,
} from '@/platform/persistence/schema/history/runtime'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { deriveSchemaEdge } from '@/platform/persistence/schema/history/edgeDiff'
import { compileContract } from '@/platform/persistence/schema/contract'
import { persistenceSchema, logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { column } from '@/platform/persistence/schema/dsl'
import { maybePreMigrationBackup } from '../src/services/backupScheduler'

import { prepareDatabaseProviderForBoot } from '@/modules/system-operations/composition'
import { acquireLock } from '@/util/lock'
import { extractTarGz } from '@/util/archive'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'

const originalHistory = schemaHistoryRuntime()
const head = persistenceHead()
const tables = persistenceSchema.tables.map((table) =>
  table.id === 'tasks'
    ? {
        ...table,
        columns: {
          ...table.columns,
          backupProbe: column.text('backup_probe', { nullable: true }),
        },
      }
    : table,
)
const tableById = new Map(tables.map((table) => [table.id, table]))
// Contributions own the same table objects as the roster.
const registry = {
  ...persistenceSchema,
  tables,
  contributions: persistenceSchema.contributions.map((contribution) => ({
    ...contribution,
    tables: contribution.tables.map((table) => tableById.get(table.id)!),
  })),
}
const successor = createHistoryVersion({
  registry,
  previous: head,
  edge: deriveSchemaEdge('add-column', head.contract.contract, compileContract(registry)),
  slug: 'pre-backup',
})

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-premig-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  // RFC-254: on Windows bun:sqlite frees the file handle on GC, not close(), so a
  // bare rm after close() hits EBUSY. removeTempDirSync forces a GC then deletes.
  registerSchemaHistoryRuntime(originalHistory)
  for (const d of tmps.splice(0)) removeTempDirSync(d)
})

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

describe('maybePreMigrationBackup', () => {
  test('fully-migrated DB (up to date) → no backup', async () => {
    const home = tmp()
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath })
    sqliteOf(db).close()

    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
      enabled: true,
      now: 1,
    })
    expect(r).toBeNull()
  })

  test('DB behind the binary → raw pre-migration backup', async () => {
    const home = tmp()
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath })
    // A real declared successor makes the current database older than the binary.
    const s = sqliteOf(db)
    registerSchemaHistoryRuntime({
      ...originalHistory,
      head: () => successor,
      history: () => [head, successor],
    })
    s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    s.close()

    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
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
    const db = openDb({ path: dbPath })
    const s = sqliteOf(db)
    registerSchemaHistoryRuntime({
      ...originalHistory,
      head: () => successor,
      history: () => [head, successor],
    })
    s.close()
    const r = await maybePreMigrationBackup({
      appHome: home,
      dbPath,
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
      enabled: true,
      now: 1,
    })
    expect(r).toBeNull()
  })
})

for (const lockOwner of ['boot', 'migrate'] as const)
  test(`AF-D9 ${lockOwner} backs up the old epoch-2 history under the daemon lock before applying its edge`, async () => {
    const home = tmp(),
      lockPath = join(home, '.daemon.lock')
    const common = {
      config: { provider: 'sqlite' as const },
      contract: logicalSchemaContract,
      sqlitePath: join(home, 'db.sqlite'),
      generationPointerPath: join(home, 'database-generation.json'),
      operationsRoot: join(home, 'database-migrations'),
      lockPath,
      sqliteOptions: {},
      backupOnMigration: true,
    }
    const first = await prepareDatabaseProviderForBoot(common)
    await first.runtime.close()
    const pointer = readGenerationPointerV2(common.generationPointerPath)
    if (pointer.payload.database.kind !== 'sqlite-file') throw new Error('fixture')
    const dbPath = join(home, pointer.payload.database.relativePath)
    registerSchemaHistoryRuntime({
      ...originalHistory,
      head: () => successor,
      history: () => [head, successor],
    })
    const lock = lockOwner === 'boot' ? acquireLock(lockPath) : undefined
    try {
      const prepared = await prepareDatabaseProviderForBoot({
        ...common,
        ...(lock ? { lock } : {}),
        beforeSqliteOpen() {
          expect(() => acquireLock(lockPath)).toThrow()
        },
      })
      try {
        const native = new Database(dbPath, { readonly: true })
        try {
          expect(
            native.query('SELECT MAX(version) AS version FROM aw_meta_schema_history').get(),
          ).toEqual({ version: successor.contract.version })
        } finally {
          native.close()
        }
        const backup = readdirSync(join(home, 'backups')).find((name) =>
          name.startsWith('pre-migration-'),
        )!
        expect(backup).toBeTruthy()
        const extracted = join(home, 'old-snapshot')
        mkdirSync(extracted)
        await extractTarGz(join(home, 'backups', backup), extracted)
        const old = new Database(join(extracted, 'db.sqlite'), { readonly: true })
        try {
          expect(
            old.query('SELECT MAX(version) AS version FROM aw_meta_schema_history').get(),
          ).toEqual({ version: head.contract.version })
          expect(
            (old.query('PRAGMA table_info(tasks)').all() as { name: string }[]).some(
              (c) => c.name === 'backup_probe',
            ),
          ).toBeFalse()
        } finally {
          old.close()
        }
      } finally {
        await prepared.runtime.close()
      }
    } finally {
      lock?.release()
    }
  })
