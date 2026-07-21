// RFC-213 PR-1a — cold restore. Tests are the design-gate corrections
// (design/RFC-213-disaster-recovery/design.md §7):
//   - AC-1 roundtrip mutates the LIVE db BETWEEN backup and restore, then asserts
//     EVERY table (enumerated from sqlite_master) reverts — a swap-disabled
//     mutation reds because live != backup at restore time.
//   - stale-WAL: the live db has uncheckpointed WAL frames at swap time; skipping
//     the -wal/-shm unlink would replay them onto the new db → mismatch.
//   - corrupt incoming / downgrade / safety-backup-fail all REFUSE with the live
//     db byte-unchanged.
//
// MUTATION CHECKS (manually verified):
//   - comment out the DB rename in restoreBackup → roundtrip counts stay at the
//     mutated live values → red.
//   - drop the `-wal`/`-shm` unlink → stale-WAL test replays old rows → red.
//   - remove the incoming quick_check → corrupt-incoming test swaps in garbage → red.
//   - invert computeRestoreDirection → downgrade test accepts a newer backup → red.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createBackup } from '../src/services/backup'
import {
  computeRestoreDirection,
  restoreBackup,
  swapInDbFile,
  RestoreDowngradeError,
  RestoreIntegrityError,
  RestoreSafetyBackupError,
} from '../src/services/restore'
import { writeManifest, type BackupManifest } from '../src/services/backupManifest'
import { tarGz } from '../src/util/archive'

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

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

async function seedWorkflows(dbPath: string, n: number): Promise<void> {
  const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
  for (let i = 0; i < n; i++) {
    await db.insert(workflows).values({
      id: ulid(),
      name: `wf-${i}`,
      definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
    })
  }
  const s = sqliteOf(db)
  s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  s.close()
}

/** {table -> row count} for every user table (dynamic — catches a dropped table). */
function allTableCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true })
  try {
    // Exclude __drizzle_migrations (schema bookkeeping) and recovery_events
    // (restore legitimately writes its OWN audit row — asserting it reverts would
    // be wrong; the workflows/other-table reversion is the real oracle).
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('__drizzle_migrations','recovery_events')",
      )
      .all() as { name: string }[]
    const out: Record<string, number> = {}
    for (const t of tables) {
      out[t.name] = (db.query(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number }).n
    }
    return out
  } finally {
    db.close()
  }
}

describe('computeRestoreDirection (pure gate)', () => {
  test('null identity = forward; equal = same; newer = downgrade; older = forward', () => {
    expect(computeRestoreDirection(null, 100)).toBe('forward')
    expect(computeRestoreDirection(100, 100)).toBe('same')
    expect(computeRestoreDirection(101, 100)).toBe('downgrade')
    expect(computeRestoreDirection(99, 100)).toBe('forward')
  })
})

describe('RFC-213 restore roundtrip (AC-1)', () => {
  test('mutating the live DB between backup and restore is reverted across ALL tables', async () => {
    const appHome = tmp('rfc213-rt-')
    const dbPath = join(appHome, 'db.sqlite')
    await seedWorkflows(dbPath, 2)
    const backupCounts = allTableCounts(dbPath)
    expect(backupCounts.workflows).toBe(2)

    // Backup the seeded state.
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const res = await createBackup({ db, appHome, now: 1 })
    // Mutate the LIVE db AFTER the backup: add a 3rd workflow.
    await db.insert(workflows).values({
      id: ulid(),
      name: 'wf-extra',
      definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
    })
    const s = sqliteOf(db)
    s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    s.close()
    expect(allTableCounts(dbPath).workflows).toBe(3)

    // Restore → everything reverts to the backup state.
    await restoreBackup(res.path, { appHome, dbPath, migrationsFolder: MIGRATIONS, now: 2 })
    expect(allTableCounts(dbPath)).toEqual(backupCounts)
    expect(allTableCounts(dbPath).workflows).toBe(2)
  })
})

describe('swapInDbFile — sidecar cleanup ordering (design gate blocker #2)', () => {
  // The load-bearing step: delete stale -wal/-shm BEFORE the rename. SQLite's own
  // WAL-mismatch detection masks this at the DB-content level, so assert the
  // sidecar removal directly. MUTATION: skip the unlink → the -wal survives → red.
  test('deletes stale -wal/-shm and renames the incoming DB in', () => {
    const appHome = tmp('rfc213-swap-')
    const dbPath = join(appHome, 'db.sqlite')
    writeFileSync(dbPath, Buffer.from('OLD DB'))
    writeFileSync(`${dbPath}-wal`, Buffer.from('STALE WAL'))
    writeFileSync(`${dbPath}-shm`, Buffer.from('STALE SHM'))
    const incoming = join(appHome, 'incoming.sqlite')
    writeFileSync(incoming, Buffer.from('NEW DB'))

    swapInDbFile(incoming, dbPath)

    expect(readFileSync(dbPath)).toEqual(Buffer.from('NEW DB'))
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}-shm`)).toBe(false)
    expect(existsSync(incoming)).toBe(false) // renamed away, not copied
  })
})

describe('RFC-213 restore — crash-safe swap over a live WAL', () => {
  test('a stale uncheckpointed WAL on the live DB does not replay onto the restored DB', async () => {
    const appHome = tmp('rfc213-wal-')
    const dbPath = join(appHome, 'db.sqlite')

    // 1) A clean 2-workflow backup (VACUUM'd — no WAL).
    await seedWorkflows(dbPath, 2)
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })

    // 2) Add 5 more rows and FREEZE the on-disk db+wal+shm WHILE the frames are
    //    still only in the WAL (copy before close, which would checkpoint them).
    for (let i = 0; i < 5; i++) {
      await db.insert(workflows).values({
        id: ulid(),
        name: `wf-wal-${i}`,
        definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      })
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(true)
    const frozen = tmp('rfc213-wal-frozen-')
    cpSync(dbPath, join(frozen, 'db.sqlite'))
    cpSync(`${dbPath}-wal`, join(frozen, 'db.sqlite-wal'))
    if (existsSync(`${dbPath}-shm`)) cpSync(`${dbPath}-shm`, join(frozen, 'db.sqlite-shm'))
    sqliteOf(db).close()

    // 3) Install the frozen trio as the LIVE db — a db.sqlite whose WAL holds 5
    //    uncheckpointed rows (reads as 7), exactly a crashed daemon's state.
    for (const s of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm']) {
      if (existsSync(join(frozen, s))) cpSync(join(frozen, s), join(appHome, s))
    }
    expect(allTableCounts(dbPath).workflows).toBe(7) // sanity: the WAL is live

    // 4) Restore the 2-workflow backup. The swap must delete the stale -wal/-shm
    //    BEFORE renaming, or the reopened DB replays the 5 stale frames.
    await restoreBackup(backup.path, { appHome, dbPath, migrationsFolder: MIGRATIONS, now: 2 })
    expect(allTableCounts(dbPath).workflows).toBe(2)
  })
})

describe('RFC-213 restore refusals leave the live DB untouched', () => {
  test('a corrupt incoming backup is refused (RestoreIntegrityError)', async () => {
    const appHome = tmp('rfc213-corrupt-')
    const dbPath = join(appHome, 'db.sqlite')
    await seedWorkflows(dbPath, 1)
    const liveBytes = readFileSync(dbPath)

    // Build a tarball whose db.sqlite is garbage + a plausible manifest.
    const staging = tmp('rfc213-corrupt-stage-')
    writeFileSync(join(staging, 'db.sqlite'), Buffer.from('not a database at all!!!'))
    const manifest: BackupManifest = {
      manifestVersion: 1,
      kind: 'manual',
      createdAt: 1,
      appVersion: '0.0.0',
      includesWorktrees: false,
      migration: { lastHash: null, lastCreatedAt: null },
    }
    writeManifest(staging, manifest)
    const badTar = join(appHome, 'bad.tar.gz')
    await tarGz(staging, badTar)

    await expect(
      restoreBackup(badTar, { appHome, dbPath, migrationsFolder: MIGRATIONS, now: 2 }),
    ).rejects.toBeInstanceOf(RestoreIntegrityError)
    expect(readFileSync(dbPath)).toEqual(liveBytes)
  })

  test('a NEWER backup (migration ahead of this binary) is refused (RestoreDowngradeError)', async () => {
    const appHome = tmp('rfc213-down-')
    const dbPath = join(appHome, 'db.sqlite')
    await seedWorkflows(dbPath, 1)
    const liveBytes = readFileSync(dbPath)

    // A real backup, but forge its manifest to a created_at far in the future.
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()
    // Repack with a forged newer identity.
    const staging = tmp('rfc213-down-stage-')
    const { extractTarGz } = await import('../src/util/archive')
    await extractTarGz(backup.path, staging)
    const forged: BackupManifest = {
      manifestVersion: 1,
      kind: 'manual',
      createdAt: 1,
      appVersion: '0.0.0',
      includesWorktrees: false,
      migration: { lastHash: 'future', lastCreatedAt: 9_999_999_999_999 },
    }
    writeManifest(staging, forged)
    const forgedTar = join(appHome, 'forged.tar.gz')
    await tarGz(staging, forgedTar)

    await expect(
      restoreBackup(forgedTar, { appHome, dbPath, migrationsFolder: MIGRATIONS, now: 2 }),
    ).rejects.toBeInstanceOf(RestoreDowngradeError)
    expect(readFileSync(dbPath)).toEqual(liveBytes)
  })

  test('a failing safety backup aborts before the swap (RestoreSafetyBackupError)', async () => {
    const appHome = tmp('rfc213-safety-')
    const dbPath = join(appHome, 'db.sqlite')
    await seedWorkflows(dbPath, 2)
    const liveBytes = readFileSync(dbPath)

    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    // Sabotage the safety backup: pre-create its exact output path as a DIRECTORY
    // so rawCopyDb's `tar -czf <dir>` fails. Filename mirrors rawDbSnapshot's stem.
    const now = 5
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
    mkdirSync(join(appHome, 'backups', `pre-restore-${stamp}.tar.gz`), { recursive: true })

    await expect(
      restoreBackup(backup.path, { appHome, dbPath, migrationsFolder: MIGRATIONS, now }),
    ).rejects.toBeInstanceOf(RestoreSafetyBackupError)
    // Live DB untouched — the swap never ran.
    expect(readFileSync(dbPath)).toEqual(liveBytes)
  })

  test('--no-safety-backup skips the safety copy (does not abort)', async () => {
    const appHome = tmp('rfc213-nosafety-')
    const dbPath = join(appHome, 'db.sqlite')
    await seedWorkflows(dbPath, 2)
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    const r = await restoreBackup(backup.path, {
      appHome,
      dbPath,
      migrationsFolder: MIGRATIONS,
      now: 2,
      noSafetyBackup: true,
    })
    expect(r.safetyBackupPath).toBeNull()
    expect(r.restored.db).toBe(true)
  })
})

describe('RFC-213 G4a mismatch-protect: restore suspends auto-recovery for non-terminal tasks', () => {
  // Prevents the design-gate data loss: after a restore the DB rows are backup-era
  // but the worktrees are current, so auto-resume must NOT silently roll a newer
  // worktree back to a stale pre_snapshot. Reuses auto_recovery_suspended (which
  // both auto loops already skip). MUTATION: skip the suspend UPDATE → the running
  // task stays unsuspended → this reds.
  test('non-terminal tasks are suspended; terminal tasks are not', async () => {
    const appHome = tmp('rfc213-suspend-')
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    const wfId = ulid()
    db.insert(workflows)
      .values({
        id: wfId,
        name: 'wf',
        definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
      })
      .run()
    const mkTask = (status: string): string => {
      const id = ulid()
      db.insert(tasks)
        .values({
          id,
          name: 't',
          workflowId: wfId,
          workflowSnapshot: '{}',
          repoPath: '/r',
          worktreePath: '/w',
          baseBranch: 'main',
          branch: `agent-workflow/${id}`,
          status: status as never,
          inputs: '{}',
          startedAt: 0,
        })
        .run()
      return id
    }
    const runningId = mkTask('running')
    const doneId = mkTask('done')
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    await restoreBackup(backup.path, { appHome, dbPath, migrationsFolder: MIGRATIONS, now: 2 })

    const check = new Database(dbPath, { readonly: true })
    const suspended = (id: string): number =>
      (
        check.query('SELECT auto_recovery_suspended AS s FROM tasks WHERE id = ?').get(id) as {
          s: number
        }
      ).s
    try {
      expect(suspended(runningId)).toBe(1) // non-terminal → suspended
      expect(suspended(doneId)).toBe(0) // terminal → untouched
    } finally {
      check.close()
    }
  })
})

describe('restore CLI wrapper guard rails', () => {
  test('no tarball → usage error; missing file → error (both before touching state)', async () => {
    const { restoreCommand } = await import('../src/cli/restore')
    const noArg = await restoreCommand([])
    expect(noArg.status).toBe('error')
    expect(noArg.output).toContain('usage:')

    const missing = await restoreCommand([join(tmp('rfc213-cli-'), 'nope.tar.gz')])
    expect(missing.status).toBe('error')
    expect(missing.output).toContain('no such file')
  })
})
