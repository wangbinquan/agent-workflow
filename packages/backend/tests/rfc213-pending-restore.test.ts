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
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { createBackup } from '../src/services/backup'
import {
  applyPendingRestoreIfAny,
  hasPendingRestore,
  stagePendingRestore,
} from '../src/services/pendingRestore'

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
