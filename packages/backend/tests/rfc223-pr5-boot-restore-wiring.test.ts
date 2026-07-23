// RFC-223 PR-5 — boot/restore placement and real backup forward-restore proof.
//
// The barrier is the first post-migration production behavior and is not wrapped
// in best-effort handling. Restore must copy filesystem state, open/forward-
// migrate the restored DB, run the same barrier, and only then expose/suspend/
// reconstruct restored state. `--no-migrate` intentionally keeps the old schema
// and skips a barrier that cannot query 0116 columns.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../src/db/client'
import { createBackup } from '../src/services/backup'
import { maybePreMigrationBackup } from '../src/services/backupScheduler'
import { rawCopyDb } from '../src/services/rawDbSnapshot'
import { restoreBackup, validateBackupForStage } from '../src/services/restore'
import { extractTarGz, tarGz } from '../src/util/archive'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tmps: string[] = []

describe('RFC-223 PR-5 boot/restore source ordering', () => {
  test('boot barrier is fail-closed immediately after db-ready and before every consumer', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf-8')
    const dbReady = source.indexOf("log.info('db ready'")
    const barrier = source.indexOf('runSkillIdentityMigrationBarrier', dbReady)
    const gate = source.indexOf('activateBootReverify()', barrier)
    const firstUserQuery = source.indexOf('countNonSystemUsers', barrier)
    const orphanReap = source.indexOf('reapOrphanRuns(db)', barrier)
    const fusionRecovery = source.indexOf('recoverFusionDecisions', barrier)
    const liveReconcile = source.indexOf('reconcileSkillLiveFiles', barrier)
    const fusionSeeder = source.indexOf('seedFusionResources', barrier)
    const httpCreate = source.indexOf('const app = createApp', barrier)
    expect(dbReady).toBeGreaterThan(-1)
    expect(barrier).toBeGreaterThan(dbReady)
    expect(gate).toBeGreaterThan(barrier)
    for (const later of [
      firstUserQuery,
      orphanReap,
      fusionRecovery,
      liveReconcile,
      fusionSeeder,
      httpCreate,
    ]) {
      expect(later).toBeGreaterThan(barrier)
    }
    expect(httpCreate).toBeGreaterThan(gate)
    // No best-effort catch can turn a failed identity proof into a live daemon.
    const nextStep = source.indexOf('// RFC-036 bootstrap hint', barrier)
    expect(source.slice(dbReady, nextStep)).not.toContain('try {')
    expect(source.slice(dbReady, nextStep)).not.toContain('catch')
  })

  test('restore copies FS then runs the barrier before restored-state consumers', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'restore.ts'),
      'utf-8',
    )
    const copySkills = source.indexOf('cpSync(stagedSkills, liveSkills')
    const openRestored = source.indexOf('const db = openDb', copySkills)
    const condition = source.indexOf("willMigrate || direction === 'same'", openRestored)
    const barrier = source.indexOf('runSkillIdentityMigrationBarrier', condition)
    const suspend = source.indexOf('suspendNonTerminalTasksAfterRestore(db)', barrier)
    const reconstruct = source.indexOf('reconstructWorktrees(db, staging)', barrier)
    const recoveryEvent = source.indexOf('recordRecoveryEvent(db', barrier)
    expect(copySkills).toBeGreaterThan(-1)
    expect(openRestored).toBeGreaterThan(copySkills)
    expect(condition).toBeGreaterThan(openRestored)
    expect(barrier).toBeGreaterThan(condition)
    expect(suspend).toBeGreaterThan(barrier)
    expect(reconstruct).toBeGreaterThan(barrier)
    expect(recoveryEvent).toBeGreaterThan(barrier)
  })
})

describe('RFC-223 PR-5 real backup restore modes', () => {
  afterEach(() => {
    for (const path of tmps.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  test('forward restore applies 0116 then migrates restored legacy FS to skill id', async () => {
    const sourceHome = temp('aw-pr5-forward-source-')
    const frozen = frozenAt0115()
    const backup = await makeSkillBackup(sourceHome, frozen, 'legacy-forward', 'id-forward', true)
    const targetHome = temp('aw-pr5-forward-target-')
    createEmptyLiveDb(targetHome)

    const result = await restoreBackup(backup, {
      appHome: targetHome,
      dbPath: join(targetHome, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      now: 501,
    })
    expect(result.direction).toBe('forward')
    expect(result.migrated).toBe(true)
    assertRestoredCanonical(targetHome, 'legacy-forward', 'id-forward')
  })

  test('same-schema restore still runs the barrier for non-canonical DB/FS paths', async () => {
    const sourceHome = temp('aw-pr5-same-source-')
    const backup = await makeSkillBackup(sourceHome, MIGRATIONS, 'legacy-same', 'id-same', false)
    const targetHome = temp('aw-pr5-same-target-')
    createEmptyLiveDb(targetHome)

    const result = await restoreBackup(backup, {
      appHome: targetHome,
      dbPath: join(targetHome, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      now: 502,
    })
    expect(result.direction).toBe('same')
    expect(result.migrated).toBe(false)
    assertRestoredCanonical(targetHome, 'legacy-same', 'id-same')
  })

  test('forward --no-migrate preserves the old schema/legacy FS escape hatch', async () => {
    const sourceHome = temp('aw-pr5-no-migrate-source-')
    const frozen = frozenAt0115()
    const backup = await makeSkillBackup(
      sourceHome,
      frozen,
      'legacy-no-migrate',
      'id-no-migrate',
      true,
    )
    const targetHome = temp('aw-pr5-no-migrate-target-')
    createEmptyLiveDb(targetHome)

    const result = await restoreBackup(backup, {
      appHome: targetHome,
      dbPath: join(targetHome, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      noMigrate: true,
      now: 503,
    })
    expect(result.direction).toBe('forward')
    expect(result.migrated).toBe(false)
    const raw = new Database(join(targetHome, 'db.sqlite'), { readonly: true })
    try {
      const columns = raw
        .query("SELECT name FROM pragma_table_info('skill_versions')")
        .all() as Array<{ name: string }>
      expect(columns.map((row) => row.name)).toContain('skill_name')
      expect(columns.map((row) => row.name)).not.toContain('skill_id')
    } finally {
      raw.close()
    }
    expect(existsSync(join(targetHome, 'skills', 'legacy-no-migrate'))).toBe(true)
    expect(existsSync(join(targetHome, 'skills', 'id-no-migrate'))).toBe(false)
  })

  test('raw pre-migration backup round-trips frozen 0115 DB and legacy skill tree', async () => {
    const sourceHome = temp('aw-pr5-raw-source-')
    const frozen = frozenAt0115()
    const dbPath = join(sourceHome, 'db.sqlite')
    const db = openDb({ path: dbPath, migrationsFolder: frozen })
    const raw = sqliteOf(db)
    raw
      .query(
        `INSERT INTO skills
           (id, name, source_kind, managed_path, content_version,
            reservation_state, version_state)
         VALUES (?, ?, 'managed', ?, 1, 'ready', 'snapshot-authoritative')`,
      )
      .run('raw-id', 'raw-legacy', 'skills/raw-legacy/files')
    raw
      .query(
        `INSERT INTO skill_versions
           (id, skill_name, version_index, files_path, source, author_user_id,
            content_hash)
         VALUES (?, ?, 1, ?, 'initial', '__system__', 'fixture-hash')`,
      )
      .run('raw-version', 'raw-legacy', 'skills/raw-legacy/versions/v1/files')
    writeTree(join(sourceHome, 'skills', 'raw-legacy', 'files'), 'raw-live-bytes')
    writeTree(join(sourceHome, 'skills', 'raw-legacy', 'versions', 'v1', 'files'), 'raw-v1-bytes')
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    raw.close()

    const backup = await maybePreMigrationBackup({
      appHome: sourceHome,
      dbPath,
      migrationsFolder: MIGRATIONS,
      enabled: true,
      now: 504,
    })
    expect(backup).not.toBeNull()
    const extracted = temp('aw-pr5-raw-extracted-')
    await extractTarGz(backup!, extracted)
    expect(
      readFileSync(join(extracted, 'skills', 'raw-legacy', 'files', 'SKILL.md'), 'utf-8'),
    ).toContain('raw-live-bytes')

    const targetHome = temp('aw-pr5-raw-target-')
    createEmptyLiveDb(targetHome)
    writeTree(join(targetHome, 'skills', 'new-generation'), 'must-be-replaced')
    await restoreBackup(backup!, {
      appHome: targetHome,
      dbPath: join(targetHome, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      noMigrate: true,
      now: 505,
    })
    const restored = new Database(join(targetHome, 'db.sqlite'), { readonly: true })
    try {
      const columns = restored
        .query("SELECT name FROM pragma_table_info('skill_versions')")
        .all() as Array<{ name: string }>
      expect(columns.map((column) => column.name)).toContain('skill_name')
      expect(columns.map((column) => column.name)).not.toContain('skill_id')
    } finally {
      restored.close()
    }
    expect(
      readFileSync(join(targetHome, 'skills', 'raw-legacy', 'files', 'SKILL.md'), 'utf-8'),
    ).toContain('raw-live-bytes')
    expect(existsSync(join(targetHome, 'skills', 'new-generation'))).toBe(false)
  })

  test('skill rows without a real skills payload are refused by cold and staged restore', async () => {
    const sourceHome = temp('aw-pr5-db-only-skill-source-')
    const frozen = frozenAt0115()
    const full = await makeSkillBackup(
      sourceHome,
      frozen,
      'missing-payload',
      'missing-payload-id',
      true,
    )
    const extracted = temp('aw-pr5-db-only-skill-stage-')
    await extractTarGz(full, extracted)
    rmSync(join(extracted, 'skills'), { recursive: true, force: true })
    const dbOnly = join(sourceHome, 'db-only-skill.tar.gz')
    await tarGz(extracted, dbOnly)

    const targetHome = temp('aw-pr5-db-only-skill-target-')
    createEmptyLiveDb(targetHome)
    writeTree(join(targetHome, 'skills', 'live-sentinel'), 'still-live')
    await expect(
      restoreBackup(dbOnly, {
        appHome: targetHome,
        dbPath: join(targetHome, 'db.sqlite'),
        migrationsFolder: MIGRATIONS,
        noSafetyBackup: true,
        now: 506,
      }),
    ).rejects.toThrow(/skill rows but no matching skills filesystem payload/)
    expect(existsSync(join(targetHome, 'skills', 'live-sentinel', 'SKILL.md'))).toBe(true)
    await expect(
      validateBackupForStage(dbOnly, {
        appHome: targetHome,
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toThrow(/skill rows but no matching skills filesystem payload/)
  })

  test('empty DB-only restore clears the prior live skills generation', async () => {
    const sourceHome = temp('aw-pr5-empty-db-source-')
    createEmptyLiveDb(sourceHome)
    const dbOnly = (
      await rawCopyDb({
        kind: 'pre-restore',
        appHome: sourceHome,
        dbPath: join(sourceHome, 'db.sqlite'),
        now: 507,
      })
    ).path

    const targetHome = temp('aw-pr5-empty-db-target-')
    createEmptyLiveDb(targetHome)
    writeTree(join(targetHome, 'skills', 'old-skill-root'), 'old-generation')
    await restoreBackup(dbOnly, {
      appHome: targetHome,
      dbPath: join(targetHome, 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      now: 508,
    })
    expect(existsSync(join(targetHome, 'skills', 'old-skill-root'))).toBe(false)
    expect(readdirSync(join(targetHome, 'skills'))).toEqual([])
  })
})

async function makeSkillBackup(
  appHome: string,
  migrationsFolder: string,
  name: string,
  id: string,
  legacySchema: boolean,
): Promise<string> {
  const dbPath = join(appHome, 'db.sqlite')
  const db = openDb({ path: dbPath, migrationsFolder })
  const raw = sqliteOf(db)
  raw
    .query(
      `INSERT INTO skills
         (id, name, source_kind, managed_path, content_version,
          reservation_state, version_state)
       VALUES (?, ?, 'managed', ?, 1, 'ready', 'snapshot-authoritative')`,
    )
    .run(id, name, `skills/${name}/files`)
  if (legacySchema) {
    raw
      .query(
        `INSERT INTO skill_versions
           (id, skill_name, version_index, files_path, source, author_user_id,
            content_hash)
         VALUES (?, ?, 1, ?, 'initial', '__system__', 'fixture-hash')`,
      )
      .run(`version-${id}`, name, `skills/${name}/versions/v1/files`)
  } else {
    raw
      .query(
        `INSERT INTO skill_versions
           (id, skill_id, version_index, files_path, source, author_user_id,
            content_hash)
         VALUES (?, ?, 1, ?, 'initial', '__system__', 'fixture-hash')`,
      )
      .run(`version-${id}`, id, `skills/${name}/versions/v1/files`)
  }
  writeTree(join(appHome, 'skills', name, 'files'), `${name}-live`)
  writeTree(join(appHome, 'skills', name, 'versions', 'v1', 'files'), `${name}-v1`)
  const backup = await createBackup({ db, appHome, now: Date.now() })
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  raw.close()
  return backup.path
}

function assertRestoredCanonical(appHome: string, name: string, id: string): void {
  const raw = new Database(join(appHome, 'db.sqlite'), { readonly: true })
  try {
    expect(raw.query('SELECT managed_path AS path FROM skills WHERE id = ?').get(id)).toEqual({
      path: `skills/${id}/files`,
    })
    expect(
      raw.query('SELECT skill_id AS skillId, files_path AS filesPath FROM skill_versions').get(),
    ).toEqual({
      skillId: id,
      filesPath: `skills/${id}/versions/v1/files`,
    })
  } finally {
    raw.close()
  }
  expect(existsSync(join(appHome, 'skills', name))).toBe(false)
  expect(readFileSync(join(appHome, 'skills', id, 'files', 'SKILL.md'), 'utf-8')).toContain(
    `${name}-live`,
  )
}

function frozenAt0115(): string {
  const folder = temp('aw-pr5-migrations-0115-')
  cpSync(MIGRATIONS, folder, { recursive: true })
  const journalPath = join(folder, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8'))
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 114)
  writeFileSync(journalPath, JSON.stringify(journal))
  return folder
}

function createEmptyLiveDb(appHome: string): void {
  const db = openDb({
    path: join(appHome, 'db.sqlite'),
    migrationsFolder: MIGRATIONS,
  })
  sqliteOf(db).close()
}

function writeTree(root: string, marker: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `# ${marker}\n`)
}

function sqliteOf(db: DbClient): Database {
  return (db as unknown as { $client: Database }).$client
}

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(path)
  return path
}
