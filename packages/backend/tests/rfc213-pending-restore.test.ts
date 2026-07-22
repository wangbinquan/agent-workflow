// RFC-213 PR-1b — staged ("hot") restore applied on boot.
//
// design/RFC-213-disaster-recovery/design.md §4.2 / §7 #6: applyPendingRestoreIfAny
// runs AFTER acquireLock and BEFORE openDb, so the FIRST openDb connection sees
// the RESTORED database. Idempotent: a marker whose tarball is gone = already
// consumed → clear + continue (never fail-closed, or a half-consumed restore
// bricks every boot).
//
// MUTATION CHECKS (manually verified):
//   - skip deleting/clearing the marker after restore → the second
//     applyPendingRestoreIfAny re-applies (returns true) → the idempotency test reds.
//   - make applyPendingRestoreIfAny ignore a tarball-missing marker (proceed to
//     restoreBackup) → the "already consumed" test throws → reds.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { createBackup } from '../src/services/backup'
import {
  applyPendingRestoreIfAny,
  clearPendingRestore,
  hasPendingRestore,
  listFailedRestores,
  readPendingRestore,
  stagePendingRestore,
} from '../src/services/pendingRestore'
import {
  RestoreDowngradeError,
  RestoreIntegrityError,
  RestorePostSwapError,
  validateBackupForStage,
} from '../src/services/restore'
import { readMigrationAxisFromJournal, writeManifest } from '../src/services/backupManifest'
import { tarGz } from '../src/util/archive'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-pending-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

async function addWorkflows(db: DbClient, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.insert(workflows).values({
      id: ulid(),
      name: `wf-${ulid()}`,
      definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
    })
  }
}

function countWorkflows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.query('SELECT count(*) AS n FROM workflows').get() as { n: number }).n
  } finally {
    db.close()
  }
}

describe('RFC-213 staged restore', () => {
  test('stage then apply-on-boot reverts the DB (as the first openDb would see)', async () => {
    const appHome = tmp()
    const dbPath = join(appHome, 'db.sqlite')
    // State A: 2 workflows. Back it up.
    let db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 2)
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()
    // State B: mutate to 3 workflows.
    db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    sqliteOf(db).close()
    expect(countWorkflows(dbPath)).toBe(3)

    // Stage the state-A backup; it must not apply until "boot".
    stagePendingRestore(backup.path, { appHome, now: 2 })
    expect(hasPendingRestore(appHome)).toBe(true)
    expect(countWorkflows(dbPath)).toBe(3) // not yet applied

    // "Boot": apply before openDb.
    const applied = await applyPendingRestoreIfAny({
      appHome,
      dbPath,
      migrationsFolder: MIGRATIONS,
    })
    expect(applied).toBe(true)
    expect(countWorkflows(dbPath)).toBe(2) // reverted to state A
    expect(hasPendingRestore(appHome)).toBe(false) // marker cleared
  })

  test('is idempotent: a second boot does not re-apply', async () => {
    const appHome = tmp()
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    stagePendingRestore(backup.path, { appHome, now: 2 })
    expect(await applyPendingRestoreIfAny({ appHome, dbPath, migrationsFolder: MIGRATIONS })).toBe(
      true,
    )
    // Second boot: nothing pending.
    expect(await applyPendingRestoreIfAny({ appHome, dbPath, migrationsFolder: MIGRATIONS })).toBe(
      false,
    )
  })

  // Impl-gate P0-1 (Codex 2026-07-22): a failure AFTER the DB swap must fail
  // closed (rethrow) — the live DB is already the restored generation, so
  // quarantine-and-continue would boot a mixed state. It still quarantines so the
  // next boot doesn't loop on the same fault.
  test('a post-swap failure rethrows RestorePostSwapError; DB is swapped; marker quarantined', async () => {
    const appHome = tmp()
    const dbPath = join(appHome, 'db.sqlite')
    // State A (1 wf) backed up; State B (2 wf) live.
    let db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()
    db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    sqliteOf(db).close()
    expect(countWorkflows(dbPath)).toBe(2)

    stagePendingRestore(backup.path, { appHome, now: 2 })

    await expect(
      applyPendingRestoreIfAny({
        appHome,
        dbPath,
        migrationsFolder: MIGRATIONS,
        now: 3,
        __afterSwapForTest: () => {
          throw new Error('boom after swap')
        },
      }),
    ).rejects.toBeInstanceOf(RestorePostSwapError)

    // The swap ALREADY happened (it precedes the injected fault) → DB is state A.
    expect(countWorkflows(dbPath)).toBe(1)
    // Anti-brick: the pending marker is quarantined (a naive reboot won't re-run
    // the same failing apply), and it is surfaced as a failed restore.
    expect(hasPendingRestore(appHome)).toBe(false)
    expect(existsSync(join(appHome, '.restore-pending.failed-3'))).toBe(true)
    expect(listFailedRestores(appHome).length).toBeGreaterThan(0)
  })

  test('a marker whose staged tarball is gone is treated as already-consumed', async () => {
    const appHome = tmp()
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    stagePendingRestore(backup.path, { appHome, now: 2 })
    // Simulate a crash AFTER the swap but before the marker was cleared: the
    // staged tarball is already deleted.
    unlinkSync(join(appHome, '.restore-pending', 'staged.tar.gz'))
    // Must NOT throw / re-restore — treat as consumed, clear, continue.
    const applied = await applyPendingRestoreIfAny({
      appHome,
      dbPath,
      migrationsFolder: MIGRATIONS,
    })
    expect(applied).toBe(false)
    expect(hasPendingRestore(appHome)).toBe(false)
  })

  test('no pending marker → no-op', async () => {
    const appHome = tmp()
    expect(
      await applyPendingRestoreIfAny({
        appHome,
        dbPath: join(appHome, 'db.sqlite'),
        migrationsFolder: MIGRATIONS,
      }),
    ).toBe(false)
  })
})

describe('restore --stage CLI', () => {
  const savedHome = process.env.AGENT_WORKFLOW_HOME
  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = savedHome
  })

  test('stages a valid backup (does not require the daemon stopped)', async () => {
    const appHome = tmp()
    process.env.AGENT_WORKFLOW_HOME = appHome
    const dbPath = join(appHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: MIGRATIONS })
    await addWorkflows(db, 1)
    const backup = await createBackup({ db, appHome, now: 1 })
    sqliteOf(db).close()

    const { restoreCommand } = await import('../src/cli/restore')
    const r = await restoreCommand([backup.path, '--stage'])
    expect(r.status).toBe('ok')
    expect(r.output).toContain('STAGED')
    expect(hasPendingRestore(appHome)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 实现门（2026-07-22）回归锁 — P1-1：stage 入口校验 + apply 失败自愈不砖 boot
// ---------------------------------------------------------------------------

/** Hand-roll a tarball with the given pieces (staging dir → tar.gz). */
async function makeTarball(
  home: string,
  pieces: { db?: 'valid' | 'garbage' | 'none'; manifestLastCreatedAt?: number },
): Promise<string> {
  const staging = join(home, `mk-${ulid()}`)
  mkdirSync(staging, { recursive: true })
  if (pieces.db === 'valid' || pieces.db === undefined) {
    const db = openDb({ path: join(staging, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    sqliteOf(db).close()
  } else if (pieces.db === 'garbage') {
    writeFileSync(join(staging, 'db.sqlite'), 'definitely not sqlite')
  }
  if (pieces.manifestLastCreatedAt !== undefined) {
    writeManifest(staging, {
      manifestVersion: 1,
      kind: 'manual',
      createdAt: 1,
      appVersion: 'x',
      includesWorktrees: false,
      migration: { lastHash: null, lastCreatedAt: pieces.manifestLastCreatedAt },
    })
  }
  const out = join(home, `mk-${ulid()}.tar.gz`)
  await tarGz(staging, out)
  rmSync(staging, { recursive: true, force: true })
  return out
}

describe('impl-gate P1-1 — validateBackupForStage refuses at the door', () => {
  test('valid backup passes; no-db / garbage-db / downgrade refuse; escape hatch works', async () => {
    const home = tmp()
    const maxWhenNow = readMigrationAxisFromJournal(MIGRATIONS).maxWhen
    const ok = await makeTarball(home, { db: 'valid', manifestLastCreatedAt: maxWhenNow })
    const plan = await validateBackupForStage(ok, { appHome: home, migrationsFolder: MIGRATIONS })
    expect(plan.direction).toBe('same')
    // no manifest = legacy backup → treated as older (forward), still valid
    const legacy = await makeTarball(home, { db: 'valid' })
    const legacyPlan = await validateBackupForStage(legacy, {
      appHome: home,
      migrationsFolder: MIGRATIONS,
    })
    expect(legacyPlan.direction).toBe('forward')

    const noDb = await makeTarball(home, { db: 'none' })
    await expect(
      validateBackupForStage(noDb, { appHome: home, migrationsFolder: MIGRATIONS }),
    ).rejects.toThrow(/no db\.sqlite/)

    const garbage = await makeTarball(home, { db: 'garbage' })
    await expect(
      validateBackupForStage(garbage, { appHome: home, migrationsFolder: MIGRATIONS }),
    ).rejects.toThrow(RestoreIntegrityError)
    // …but the explicit escape hatch lets a quick_check-failing package through
    // (staged with the SAME flag, so the boot apply honours it too).
    const escaped = await validateBackupForStage(garbage, {
      appHome: home,
      migrationsFolder: MIGRATIONS,
      skipIntegrityCheck: true,
    })
    expect(escaped.direction).toBe('forward') // no manifest → legacy → forward

    const maxWhen = readMigrationAxisFromJournal(MIGRATIONS).maxWhen
    const newer = await makeTarball(home, { db: 'valid', manifestLastCreatedAt: maxWhen + 1 })
    await expect(
      validateBackupForStage(newer, { appHome: home, migrationsFolder: MIGRATIONS }),
    ).rejects.toThrow(RestoreDowngradeError)
  })
})

describe('impl-gate P1-1 — a failed staged apply self-heals instead of bricking boot', () => {
  test('apply quarantines the staged dir, returns false, and the next boot is clean', async () => {
    const home = tmp()
    // Simulate the pre-fix arming path: a garbage tarball staged directly
    // (bypassing door validation — e.g. staged by an older binary, or bit-rot
    // after staging). The boot apply must NOT leave the marker in place.
    const garbageTar = join(home, 'garbage.tar.gz')
    writeFileSync(garbageTar, 'not a tarball')
    stagePendingRestore(garbageTar, { appHome: home, now: 7 })
    expect(hasPendingRestore(home)).toBe(true)

    const applied = await applyPendingRestoreIfAny({
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      now: 99,
    })
    expect(applied).toBe(false) // boot continues on the untouched DB
    expect(hasPendingRestore(home)).toBe(false) // marker no longer armed
    const failed = listFailedRestores(home)
    expect(failed.length).toBe(1)
    expect(failed[0]?.failedAt).toBe(99)
    expect(failed[0]?.error ?? '').not.toBe('')
    expect(existsSync(join(failed[0]!.dir, 'error.txt'))).toBe(true)

    // Second boot: nothing pending, nothing thrown — the loop is broken.
    const again = await applyPendingRestoreIfAny({
      appHome: home,
      dbPath: join(home, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
    })
    expect(again).toBe(false)
  })
})

describe('impl-gate P1-5 — pending visibility + cancel primitives', () => {
  test('readPendingRestore reflects the marker; clearPendingRestore dis-arms', async () => {
    const home = tmp()
    expect(readPendingRestore(home)).toBeNull()
    expect(clearPendingRestore(home)).toBe(false)

    const tarPath = await makeTarball(home, { db: 'valid' })
    stagePendingRestore(tarPath, { appHome: home, now: 1234, noMigrate: true })
    const info = readPendingRestore(home)
    expect(info?.requestedAt).toBe(1234)
    expect(info?.noMigrate).toBe(true)
    expect((info?.stagedBytes ?? 0) > 0).toBe(true)

    expect(clearPendingRestore(home)).toBe(true)
    expect(hasPendingRestore(home)).toBe(false)
    expect(readPendingRestore(home)).toBeNull()
  })
})
