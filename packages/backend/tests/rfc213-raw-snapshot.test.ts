// RFC-213 PR-0 — raw, corruption-tolerant DB snapshot + backup manifest.
//
// design/RFC-213-disaster-recovery/design.md §3.1 (design-gate blocker #1/#3):
// the pre-restore / pre-migration safety backup MUST be a byte copy, NOT
// createBackup/VACUUM INTO — because it has to snapshot the very corrupt (or
// new-binary-vs-old-schema) DB that VACUUM/listWorkflows would throw on.
//
// MUTATION CHECKS (manually verified):
//   - make rawCopyDb open+VACUUM instead of byte-copy → the corrupt-DB case
//     throws → its test reds.
//   - drop the try/catch in readDbMigrationIdentity → corrupt-DB identity read
//     throws → the corrupt case reds.
//   - stop writing the manifest → manifest assertions red.

import { afterEach, describe, expect, test } from 'bun:test'
import { removeTempDirSync } from './fixtures/tempDir'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../src/db/client'
import { extractTarGz } from '../src/util/archive'
import { readDbMigrationIdentity, readManifest } from '../src/services/backupManifest'
import { rawCopyDb } from '../src/services/rawDbSnapshot'
import { quickCheckDbFile } from '../src/db/integrity'
import { sqliteRawDbSnapshotMechanisms } from '../src/platform/persistence/sqlite/rawDbSnapshotMechanisms'
import { resetLoggerForTest, setLoggerStdoutWriterForTest } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}
afterEach(() => {
  resetLoggerForTest()
  for (const d of tmps.splice(0)) removeTempDirSync(d)
})

/** Open a file-backed, fully-migrated DB, checkpoint+close it, return its path
 *  (so the on-disk bytes are stable for byte-equality). */
function seedFileDb(appHome: string): string {
  const dbPath = join(appHome, 'db.sqlite')
  const db: DbClient = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
  const sqlite = (db as unknown as { $client: Database }).$client
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  sqlite.close()
  return dbPath
}

describe('RFC-213 rawCopyDb — healthy DB', () => {
  // Regression: the bare WAL-mode backup was checked readonly before its
  // auxiliary files were copied, printing a false SQLITE_CANTOPEN warning.
  test('a checkpointed bare WAL copy validates without warnings or rewriting database bytes', async () => {
    const appHome = tmp('rfc213-raw-bare-wal-')
    const dbPath = seedFileDb(appHome)
    for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
    const bytes = readFileSync(dbPath)
    expect(bytes[18]).toBe(2)
    const logs: string[] = []
    setLoggerStdoutWriterForTest((line) => logs.push(line))
    const result = await rawCopyDb({ kind: 'pre-migration', appHome, dbPath })
    const out = tmp('rfc213-bare-wal-out-')
    await extractTarGz(result.path, out)
    const copiedPath = join(out, 'db.sqlite')
    expect(logs.some((line) => line.includes('fails quick_check'))).toBe(false)
    expect(readFileSync(dbPath)).toEqual(bytes)
    expect(readFileSync(copiedPath)).toEqual(bytes)
    expect(quickCheckDbFile(copiedPath, { allowWalSidecarCreation: true }).ok).toBe(true)
    expect(readFileSync(copiedPath)).toEqual(bytes)
  })

  test('copies a live WAL/SHM pair before validation and preserves the checkpointed bytes', async () => {
    const appHome = tmp('rfc213-raw-live-wal-')
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const sqlite = (db as unknown as { $client: Database }).$client
    try {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      const bytes = readFileSync(dbPath)
      const logs: string[] = []
      setLoggerStdoutWriterForTest((line) => logs.push(line))
      const result = await rawCopyDb({ kind: 'pre-migration', appHome, dbPath })
      expect(result.copied.wal).toBe(true)
      expect(result.copied.shm).toBe(true)
      expect(logs.some((line) => line.includes('fails quick_check'))).toBe(false)
      const out = tmp('rfc213-live-wal-out-')
      await extractTarGz(result.path, out)
      expect(readFileSync(join(out, 'db.sqlite'))).toEqual(bytes)
      expect(readFileSync(dbPath)).toEqual(bytes)
    } finally {
      sqlite.close()
    }
  })

  for (const hasShm of [true, false]) {
    test(`validating uncheckpointed WAL preserves DB/WAL bytes with SHM=${hasShm}`, () => {
      const home = tmp('rfc213-uncheckpointed-check-')
      const source = join(home, 'source.sqlite')
      const copy = join(home, 'copy.sqlite')
      const writer = new Database(source, { create: true })
      try {
        writer.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('uncheckpointed');",
        )
        for (const suffix of hasShm ? ['', '-wal', '-shm'] : ['', '-wal']) {
          copyFileSync(source + suffix, copy + suffix)
        }
        const dbBytes = readFileSync(copy)
        const walBytes = readFileSync(copy + '-wal')
        expect(sqliteRawDbSnapshotMechanisms.quickCheck(copy, true).ok).toBe(true)
        expect(readFileSync(copy)).toEqual(dbBytes)
        expect(readFileSync(copy + '-wal')).toEqual(walBytes)
        const reader = new Database(copy, { readonly: true })
        try {
          expect(reader.query('SELECT value FROM evidence').get()).toEqual({
            value: 'uncheckpointed',
          })
        } finally {
          reader.close()
        }
        expect(readFileSync(copy)).toEqual(dbBytes)
        expect(readFileSync(copy + '-wal')).toEqual(walBytes)
      } finally {
        writer.close()
      }
    })
  }

  test('a busy checkpoint preserves the complete raw DB/WAL bytes during copy validation', async () => {
    const home = tmp('rfc213-busy-checkpoint-copy-')
    const dbPath = join(home, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const writer = (db as unknown as { $client: Database }).$client
    let reader: Database | null = null
    try {
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      reader = new Database(dbPath, { readonly: true })
      reader.exec('BEGIN; SELECT count(*) FROM workflows;')
      writer.exec(
        "CREATE TABLE raw_copy_evidence(value TEXT); INSERT INTO raw_copy_evidence VALUES ('pending WAL');",
      )
      const dbBytes = readFileSync(dbPath)
      const walBytes = readFileSync(dbPath + '-wal')
      expect(walBytes.length).toBeGreaterThan(32)
      const logs: string[] = []
      setLoggerStdoutWriterForTest((line) => logs.push(line))
      const result = await rawCopyDb({ kind: 'pre-migration', appHome: home, dbPath })
      expect(result.copied.wal).toBe(true)
      const out = tmp('rfc213-busy-copy-out-')
      await extractTarGz(result.path, out)
      expect(logs.some((line) => line.includes('fails quick_check'))).toBe(false)
      expect(readFileSync(join(out, 'db.sqlite'))).toEqual(dbBytes)
      expect(readFileSync(join(out, 'db.sqlite-wal'))).toEqual(walBytes)
      const archived = new Database(join(out, 'db.sqlite'), { readonly: true })
      try {
        expect(archived.query('SELECT value FROM raw_copy_evidence').get()).toEqual({
          value: 'pending WAL',
        })
      } finally {
        archived.close()
      }
      expect(readFileSync(dbPath)).toEqual(dbBytes)
      expect(readFileSync(dbPath + '-wal')).toEqual(walBytes)
    } finally {
      reader?.close()
      writer.close()
    }
  })

  test('byte-copies db.sqlite and writes a manifest with migration identity', async () => {
    const appHome = tmp('rfc213-raw-')
    const dbPath = seedFileDb(appHome)
    const srcBytes = readFileSync(dbPath)
    const identity = readDbMigrationIdentity(dbPath)
    expect(identity).not.toBeNull()
    expect(identity!.lastCreatedAt).toBeGreaterThan(0)

    const res = await rawCopyDb({ kind: 'pre-restore', appHome, dbPath, now: 1_700_000_000_000 })
    expect(existsSync(res.path)).toBe(true)
    expect(res.copied.db).toBe(true)

    // Extract and verify the DB bytes round-trip + the manifest is correct.
    const out = tmp('rfc213-raw-out-')
    await extractTarGz(res.path, out)
    expect(readFileSync(join(out, 'db.sqlite'))).toEqual(srcBytes)

    const manifest = readManifest(out)
    expect(manifest).not.toBeNull()
    expect(manifest!.kind).toBe('pre-restore')
    expect(manifest!.migration.lastCreatedAt).toBe(identity!.lastCreatedAt)
    expect(manifest!.migration.lastHash).toBe(identity!.lastHash)
  })
})

describe('RFC-213 rawCopyDb — corrupt DB (the whole point)', () => {
  test('sidecar creation never creates a missing database', () => {
    const path = join(tmp('rfc213-missing-check-'), 'absent.sqlite')
    expect(quickCheckDbFile(path, { allowWalSidecarCreation: true }).ok).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test('real page corruption remains reported and its original bytes remain recoverable', async () => {
    const appHome = tmp('rfc213-page-corrupt-copy-')
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const sqlite = (db as unknown as { $client: Database }).$client
    const root = sqlite
      .query("SELECT rootpage FROM sqlite_schema WHERE name = 'workflows'")
      .get() as {
      rootpage: number
    }
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    sqlite.close()
    const bytes = readFileSync(dbPath)
    const encoded = bytes.readUInt16BE(16)
    const pageSize = encoded === 1 ? 65_536 : encoded
    bytes[(root.rootpage - 1) * pageSize] = 0xff
    writeFileSync(dbPath, bytes)
    expect(quickCheckDbFile(dbPath, { allowWalSidecarCreation: true }).ok).toBe(false)
    expect(readFileSync(dbPath)).toEqual(bytes)
    const logs: string[] = []
    setLoggerStdoutWriterForTest((line) => logs.push(line))
    const result = await rawCopyDb({ kind: 'pre-restore', appHome, dbPath })
    expect(logs.some((line) => line.includes('fails quick_check'))).toBe(true)
    const out = tmp('rfc213-corrupt-copy-out-')
    await extractTarGz(result.path, out)
    expect(readFileSync(join(out, 'db.sqlite'))).toEqual(bytes)
  })

  test('a non-sqlite / corrupt file is still snapshotted, identity is null, bytes preserved', async () => {
    const appHome = tmp('rfc213-raw-corrupt-')
    const dbPath = join(appHome, 'db.sqlite')
    // Not a database at all — VACUUM INTO / listWorkflows would throw on this.
    const garbage = Buffer.from('this is definitely not a sqlite database\x00\x01\x02', 'utf-8')
    writeFileSync(dbPath, garbage)

    // Identity read is corruption-tolerant (null, not throw).
    expect(readDbMigrationIdentity(dbPath)).toBeNull()

    // The snapshot itself must NOT throw and must preserve the exact bytes.
    const res = await rawCopyDb({ kind: 'pre-restore', appHome, dbPath, now: 1_700_000_000_000 })
    expect(res.copied.db).toBe(true)

    const out = tmp('rfc213-raw-corrupt-out-')
    await extractTarGz(res.path, out)
    expect(readFileSync(join(out, 'db.sqlite'))).toEqual(garbage)

    const manifest = readManifest(out)
    expect(manifest!.migration.lastCreatedAt).toBeNull()
    expect(manifest!.migration.lastHash).toBeNull()
  })

  test('a missing DB file produces a tarball with copied.db=false, no throw', async () => {
    const appHome = tmp('rfc213-raw-missing-')
    const res = await rawCopyDb({
      kind: 'pre-migration',
      appHome,
      dbPath: join(appHome, 'db.sqlite'),
      now: 1_700_000_000_000,
    })
    expect(res.copied.db).toBe(false)
    expect(existsSync(res.path)).toBe(true)
  })
})

describe('RFC-213 createBackup manifest (PR-0 T2)', () => {
  test('createBackup embeds a manifest with kind + migration identity', async () => {
    const appHome = tmp('rfc213-cb-')
    const dbPath = join(appHome, 'db.sqlite')
    const db: DbClient = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const identity = readDbMigrationIdentity(dbPath)

    const { createBackup } = await import('../src/services/backup')
    const res = await createBackup({ db, kind: 'scheduled', appHome, now: 1_700_000_000_000 })
    ;(db as unknown as { $client: Database }).$client.close()

    const out = tmp('rfc213-cb-out-')
    await extractTarGz(res.path, out)
    const manifest = readManifest(out)
    expect(manifest).not.toBeNull()
    expect(manifest!.kind).toBe('scheduled')
    // createBackup reads identity from the VACUUM'd snapshot — same axis.
    expect(manifest!.migration.lastCreatedAt).toBe(identity!.lastCreatedAt)
  })
})

// RFC-213 impl-gate P0-4 (Codex 2026-07-22): the pre-restore safety tarball must
// be fsync'd (file + dir) BEFORE the caller (restore) unlinks the old WAL and
// swaps the DB — a power loss otherwise loses both the (still-buffered) safety
// tarball and the (already-unlinked) old WAL, making the old generation
// unrecoverable. Durability can't be unit-tested, so lock the source guarantee:
// the fsync of the output path AND the backups dir happens AFTER the tarGz write.
// Mutation: delete either fsyncPath call → this reds.
describe('impl-gate P0-4 — safety tarball durability (source guard)', () => {
  test('rawDbSnapshot fsyncs the tarball + backups dir after writing it', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'rawDbSnapshot.ts'),
      'utf-8',
    )
    const tarIdx = src.indexOf('await tarGz(stagingDir, outPath)')
    const fsyncOutIdx = src.indexOf('fsyncPath(outPath)')
    const fsyncDirIdx = src.indexOf('fsyncPath(backupsDir)')
    expect(tarIdx).toBeGreaterThan(0)
    expect(fsyncOutIdx).toBeGreaterThan(tarIdx)
    expect(fsyncDirIdx).toBeGreaterThan(tarIdx)
  })
})
