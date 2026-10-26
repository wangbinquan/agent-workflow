import { expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSqliteBaseline } from '@/bootstrap/persistenceBaseline'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import {
  validateBackupForStage,
  restoreBackup,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import { tarGz } from '@/util/archive'
import { openDb } from '@/db/client'
import { bootImplementation, bootDeclaration, expectBootOrder } from './helpers/daemonProgramSource'
import { readDaemonGraphSource } from './helpers/daemonGraphSource'
const source = (path: string) => readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
test('normal skill recovery remains fail-closed before consumers', () => {
  const graph = readDaemonGraphSource()
  expectBootOrder([
    'skill-operation-recovery',
    'skill-availability-gate',
    'skill-live-files',
    'fusion-resource-seed',
    'task-execution-recovery',
    'fusion-decision-recovery',
  ])
  for (const [id, call] of [
    ['skill-operation-recovery', 'recoverOperations'],
    ['skill-availability-gate', 'activateAvailabilityGate'],
  ] as const) {
    expect(bootDeclaration(id)).toMatchObject({ phase: 'prepare', failure: 'fail-closed' })
    const body = bootImplementation(graph, id)
    expect(body).toContain(`skillCatalogBoot.${call}()`)
    expect(body).not.toContain('catch')
  }
})
test('restore classifies the recorded contract before opening the active provider', () => {
  const main = source('main.ts'),
    start = main.indexOf("case 'restore':")
  expect(main.indexOf('classifyRestoreArtifact(artifact)', start)).toBeLessThan(
    main.indexOf('resolveDatabaseProviderRuntimeForRestore(', start),
  )
  expect(main.slice(start)).toContain('composeEpochMigrationCommand().restoreBackup')
  const entry = source('bootstrap/epochMigrationEntry.ts')
  expect(entry).toContain('manifest.database.schemaDigest')
  expect(entry).toContain('restore-artifact-contract-unsupported')
  expect(source('bootstrap/epochMigration.ts')).toContain(
    'bootUpgradeEnvironment: composeBootUpgradeEnvironment(epochMigrationKeys(undefined, appHome))',
  )
})
test('same-epoch restore validates before swap and retains current recovery without legacy repair', () => {
  const restore = source('platform/persistence/sqlite/systemProviderRestore.ts')
  expect(restore).not.toContain('runSkillIdentityMigrationBarrier')
  expect(restore).not.toContain('postOpenRecovery.recover')
  expect(restore).toContain('epoch-1 backup requires offline db migration restore-backup')
  const body = restore.slice(restore.indexOf('export async function restoreBackup'))
  expect(body.indexOf('verifyPortableDatabasePayload')).toBeLessThan(body.indexOf('swapInDbFile'))
  expect(body.indexOf('assertBackupSkillsPayload')).toBeLessThan(body.indexOf('swapInDbFile'))
  expect(body.indexOf('cpSync(stagedSkills, liveSkills')).toBeLessThan(
    body.indexOf('const db = openDb'),
  )
  expect(body.indexOf('const db = openDb')).toBeLessThan(
    body.indexOf('suspendNonTerminalTasksAfterRestore(db)'),
  )
  expect(body).toContain('reconstructWorktrees(db, staging)')
  expect(body).toContain('rmSync(liveSkills')
})
test('old identity, alias and filesystem outcomes remain converter tests', () => {
  const cases = readFileSync(resolve(import.meta.dir, 'skill-identity-migration.test.ts'), 'utf8')
  for (const name of [
    'canonical-alias',
    'husk-alias',
    'symlink-skills-root',
    'protocol-residue',
    'similar-support-name',
    'multi-version',
    'missing-root',
  ])
    expect(cases).toContain(name)
  expect(cases).toContain('runConversion(')
  expect(cases).toContain('before.decodedRows')
})

async function nativeArtifact(root: string, skillRows: boolean) {
  const staging = join(root, 'artifact')
  mkdirSync(staging)
  const db = createSqliteBaseline()
  try {
    if (skillRows)
      db.exec("INSERT INTO skills (id,name) VALUES ('skill-without-files','Missing payload')")
    writeFileSync(join(staging, 'db.sqlite'), db.serialize())
  } finally {
    db.close()
  }
  const artifact = join(root, 'backup.tar.gz')
  await tarGz(staging, artifact)
  return artifact
}
test('epoch-2 skill rows without a skills payload are refused by cold and staged restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc223-native-refusal-'))
  try {
    const artifact = await nativeArtifact(root, true)
    const appHome = join(root, 'home')
    const dbPath = join(appHome, 'db.sqlite')
    await expect(
      validateBackupForStage(artifact, { appHome, contract: logicalSchemaContract }),
    ).rejects.toThrow(
      'stage refused: backup contains skill rows but no matching skills filesystem payload',
    )
    await expect(
      restoreBackup(artifact, {
        appHome,
        dbPath,
        contract: logicalSchemaContract,
        noSafetyBackup: true,
      }),
    ).rejects.toThrow(
      'restore refused: backup contains skill rows but no matching skills filesystem payload',
    )
    expect(existsSync(dbPath)).toBeFalse()
    expect(existsSync(join(appHome, 'database-generation.json'))).toBeFalse()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('an empty epoch-2 DB-only restore clears the prior live skills generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc223-native-empty-'))
  try {
    const artifact = await nativeArtifact(root, false)
    const appHome = join(root, 'home'),
      dbPath = join(appHome, 'db.sqlite')
    mkdirSync(join(appHome, 'skills/prior/files'), { recursive: true })
    writeFileSync(join(appHome, 'skills/prior/files/SKILL.md'), 'old generation')
    const restored = await restoreBackup(artifact, {
      appHome,
      dbPath,
      contract: logicalSchemaContract,
      noSafetyBackup: true,
    })
    expect(existsSync(join(appHome, 'skills/prior'))).toBeFalse()
    expect(restored.restored.skills).toBeTrue()
    expect(existsSync(join(appHome, 'skills'))).toBeTrue()
    const db = openDb({ path: dbPath })
    try {
      expect(db.$client.query('SELECT id FROM skills').all()).toEqual([])
    } finally {
      db.$client.close()
    }
    expect(existsSync(join(appHome, 'database-generation.json'))).toBeTrue()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
