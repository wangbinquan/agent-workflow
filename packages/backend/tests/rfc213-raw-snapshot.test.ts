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
import type { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../src/db/client'
import { extractTarGz } from '../src/util/archive'
import { readDbMigrationIdentity, readManifest } from '../src/services/backupManifest'
import { rawCopyDb } from '../src/services/rawDbSnapshot'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
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
