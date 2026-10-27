import { restoreArtifactRegistry } from './helpers/rfc395V3/successor'
import { setDefaultTimeout, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyRestoreArtifact } from '@/bootstrap/epochMigrationEntry'
import { composeLocalEpochSwitch } from '@/bootstrap/epochMigration'
import { persistenceHead, persistencePostgresqlCatalogs } from '@/bootstrap/persistenceHead'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { resolveConfigurationValue } from '@/platform/configuration/configurationValues'
import { openDb } from '@/db/client'
import { createBackup } from '@/services/backup'
import { writeManifest } from '@/services/backupManifest'
import { tarGz } from '@/util/archive'
import { openFrozenEpoch1Db, FROZEN_MIGRATIONS } from './migration-freeze'
import { restoreSqliteBackupForTest } from './helpers/sqlitePostRestoreRecovery'
import { workflowFixture, readWorkflowFixtures } from './helpers/model'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { LEGACY_MIGRATION_HASHES } from '@/platform/persistence/migration/epoch1/journalAliases'
import { readDbMigrationIdentity } from '@/platform/persistence/migration/legacy/backupManifest'
import {
  RestoreIntegrityError,
  restoreBackup,
  validateBackupForStage,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import { parseRestoreArguments } from '@/cli/restore'
import { resolveDatabaseProviderRuntimeForRestore } from '@/platform/persistence/databaseProviderRuntime'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { removeTempDirSync } from './fixtures/tempDir'

// Unpacking, identifying and planning a frozen epoch-1 restore take about 9 s per CI-scaled case; allow 30 s.
setDefaultTimeout(30000)

// T18 E2E: an ordinary tarball must never be routed into epoch-1 conversion.
test('non-backup archives retain the restore and stage refusal before epoch routing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc395-non-backup-'))
  try {
    const contents = join(root, 'contents')
    mkdirSync(contents)
    writeFileSync(join(contents, 'README.txt'), 'not a database backup')
    const tarball = join(root, 'junk.tar.gz')
    await tarGz(contents, tarball)
    for (const artifact of [contents, tarball]) {
      await expect(classifyRestoreArtifact(artifact, 'stage')).rejects.toThrow(
        'stage refused: backup contains no db.sqlite (not a backup tarball?)',
      )
      await expect(classifyRestoreArtifact(artifact)).rejects.toThrow(
        'restore refused: backup contains no db.sqlite (not a backup tarball?)',
      )
    }
    await expect(
      validateBackupForStage(tarball, { appHome: root, contract: logicalSchemaContract }),
    ).rejects.toThrow('stage refused: backup contains no db.sqlite (not a backup tarball?)')
    expect(existsSync(join(root, '.restore-pending'))).toBeFalse()
    expect(existsSync(join(root, 'database-generation.json'))).toBeFalse()
  } finally {
    removeTempDirSync(root)
  }
})

test('an aliased epoch-1 SQLite backup is frozen conversion input and cannot enter native restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc395-old-restore-routing-'))
  const artifact = join(root, 'artifact')
  const appHome = join(root, 'home')
  mkdirSync(artifact)
  mkdirSync(appHome)
  const sourcePath = join(artifact, 'db.sqlite')
  const source = openFrozenEpoch1Db({ path: sourcePath, migrationsFolder: FROZEN_MIGRATIONS })
  const history = await loadFrozenEpoch1History()
  const [tag, aliases] = Object.entries(LEGACY_MIGRATION_HASHES).find(
    ([, aliases]) => aliases.length > 0,
  )!
  const entry = history.sqlite[history.sqliteTags.indexOf(tag)]!
  source.$client
    .query('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?')
    .run(aliases[0]!, entry.folderMillis)
  source.$client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  source.$client.close()
  writeManifest(artifact, {
    manifestVersion: 1,
    kind: 'manual',
    createdAt: 1,
    appVersion: 'frozen-epoch-1',
    includesWorktrees: false,
    migration: readDbMigrationIdentity(sourcePath)!,
  })
  const original = readFileSync(sourcePath)
  try {
    expect(await classifyRestoreArtifact(artifact)).toBe('epoch1')
    const tarball = join(root, 'old.tar.gz')
    await tarGz(artifact, tarball)
    expect(await classifyRestoreArtifact(tarball)).toBe('epoch1')
    await expect(
      restoreSqliteBackupForTest(tarball, {
        appHome,
        dbPath: join(appHome, 'db.sqlite'),
        noSafetyBackup: true,
      }),
    ).rejects.toThrow('epoch-1 backup requires offline db migration restore-backup')
    const application = composeLocalEpochSwitch({
      appHome,
      config: resolveConfigurationValue({}),
      env: process.env,
      head: persistenceHead(),
      catalogArtifacts: persistencePostgresqlCatalogs(),
    })
    const result = await application.restoreBackup({ artifact: tarball })
    expect(result.operationId).toBeTruthy()
    expect(result.plan.payload.role).toBe('restored')
    expect(result.plan.payload.blocks).toEqual([])
    expect(result.plan.approvalDigest).toMatch(/^sha256:/)
    expect(readFileSync(sourcePath)).toEqual(original)
  } finally {
    removeTempDirSync(root)
  }
})

test('an epoch-2 native backup is selected for native restore and retains business rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc395-native-restore-routing-'))
  const dbPath = join(root, 'db.sqlite')
  let db = openDb({ path: dbPath })
  try {
    await workflowFixture(db, {
      id: 'native-workflow',
      name: 'native',
      definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
    })
    const backup = await createBackup({
      contract: logicalSchemaContract,
      db,
      appHome: root,
      now: 1,
    })
    expect(await classifyRestoreArtifact(backup.path)).toBe('epoch2')
    await workflowFixture(db, {
      id: 'after-backup',
      name: 'later',
      definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
    })
    db.$client.close()
    await restoreSqliteBackupForTest(backup.path, { appHome: root, dbPath, now: 2 })
    db = openDb({ path: dbPath })
    expect((await readWorkflowFixtures(db)).map((row) => row.id)).toEqual(['native-workflow'])
    expect(db.$client.query('SELECT contract_digest FROM aw_meta_schema_history').all()).toEqual([
      { contract_digest: persistenceHead().contract.contract.digest },
    ])
  } finally {
    db.$client.close()
    removeTempDirSync(root)
  }
})

test('AF-D8 value flags are consumed before the artifact, and missing files retain the CLI message', async () => {
  expect(
    parseRestoreArguments(['--content-root', '/content', '--yes', '/backup.tar.gz']),
  ).toMatchObject({ artifact: '/backup.tar.gz', contentRoot: '/content' })
  expect(parseRestoreArguments(['/backup.tar.gz', '--content-root', '/content'])).toMatchObject({
    artifact: '/backup.tar.gz',
    contentRoot: '/content',
  })
  expect(() => parseRestoreArguments(['--content-root'])).toThrow('requires a value')
  await expect(classifyRestoreArtifact('/missing-af1-backup.tar.gz')).rejects.toThrow(
    'restore failed: no such file:',
  )
})
for (const skipIntegrityCheck of [false, true])
  test(`BF-D20 stage and cold restore diagnose unreadable SQLite, skipIntegrityCheck=${skipIntegrityCheck}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'af1-corrupt-backup-'))
    try {
      const artifact = join(root, 'artifact')
      mkdirSync(artifact)
      writeFileSync(join(artifact, 'db.sqlite'), 'not a SQLite database')
      const tarball = join(root, 'corrupt.tar.gz')
      await tarGz(artifact, tarball)
      await expect(
        validateBackupForStage(tarball, {
          appHome: join(root, 'stage'),
          contract: logicalSchemaContract,
          skipIntegrityCheck,
        }),
      ).rejects.toBeInstanceOf(RestoreIntegrityError)
      await expect(
        restoreBackup(tarball, {
          appHome: join(root, 'cold'),
          dbPath: join(root, 'cold/db.sqlite'),
          contract: logicalSchemaContract,
          skipIntegrityCheck,
          noSafetyBackup: true,
        }),
      ).rejects.toBeInstanceOf(RestoreIntegrityError)
      expect(existsSync(join(root, 'cold/db.sqlite'))).toBeFalse()
    } finally {
      removeTempDirSync(root)
    }
  })
test('AF-D8 native restore into a new home publishes a generation only after restoring its data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af1-empty-home-restore-'))
  const sourceHome = join(root, 'source'),
    appHome = join(root, 'empty')
  const source = openDb({ path: join(sourceHome, 'db.sqlite') })
  try {
    await workflowFixture(source, {
      id: 'restored-workflow',
      name: 'Restored',
      definition: '{"$schema_version":3,"inputs":[],"nodes":[],"edges":[]}',
    })
    const backup = await createBackup({
      contract: logicalSchemaContract,
      db: source,
      appHome: sourceHome,
    })
    const pointerPath = join(appHome, 'database-generation.json')
    const selected = resolveDatabaseProviderRuntimeForRestore({
      config: { provider: 'sqlite' },
      contract: logicalSchemaContract,
      sqlitePath: join(appHome, 'db.sqlite'),
      generationPointerPath: pointerPath,
      operationsRoot: join(appHome, 'database-migrations'),
    })
    try {
      if (selected.provider !== 'sqlite') throw new Error('fixture')
      expect(existsSync(pointerPath)).toBeFalse()
      await restoreBackup(backup.path, {
        appHome,
        dbPath: selected.sqlitePath,
        contract: logicalSchemaContract,
        noSafetyBackup: true,
      })
      const pointer = readGenerationPointerV2(pointerPath)
      expect(pointer.payload.role).toBe('installed')
      expect(pointer.payload.generationId).toBe(selected.generation.payload.generationId)
      expect(pointer.payload.database).toEqual({
        kind: 'sqlite-file',
        relativePath: `databases/${pointer.payload.generationId}/db.sqlite`,
      })
      if (pointer.payload.database.kind !== 'sqlite-file') throw new Error('fixture')
      const restored = openDb({ path: join(appHome, pointer.payload.database.relativePath) })
      try {
        expect((await readWorkflowFixtures(restored)).map((row) => row.id)).toEqual([
          'restored-workflow',
        ])
      } finally {
        restored.$client.close()
      }
    } finally {
      await selected.close()
    }
  } finally {
    source.$client.close()
    removeTempDirSync(root)
  }
})

for (const envelope of ['raw', 'portable', 'logical'] as const)
  test(`BF-D14 a newer epoch-2 ${envelope} backup is refused before converter selection`, async () => {
    const { appendSqliteSuccessor } = await import('./helpers/epoch2SqliteSuccessor')
    const { projectLogicalSchemaContract } =
      await import('@/platform/persistence/schema/logicalContract')
    const root = mkdtempSync(join(tmpdir(), 'bf-future-backup-'))
    const artifact = join(root, 'artifact')
    mkdirSync(artifact)
    const path = join(artifact, 'db.sqlite')
    const db = openDb({ path })
    try {
      const future = await appendSqliteSuccessor(db.$client)
      const digest = projectLogicalSchemaContract(restoreArtifactRegistry(future)).digest
      db.$client.close()
      if (envelope === 'portable')
        writeManifest(artifact, {
          manifestVersion: 2,
          kind: 'manual',
          createdAt: 1,
          appVersion: 'future-binary',
          includesWorktrees: false,
          migration: { lastHash: null, lastCreatedAt: null },
          database: {
            format: 'agent-workflow-logical-database-v1',
            provider: 'sqlite',
            sourceGenerationId: 'dbg_future',
            schemaDigest: digest,
            logicalPath: 'database/logical',
            envelopeFileDigest: `sha256:${'a'.repeat(64)}`,
            rawSqlitePath: 'db.sqlite',
          },
        })
      if (envelope === 'logical') {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(path)
        writeFileSync(
          join(artifact, 'logical-backup.json'),
          JSON.stringify({ payload: { schemaDigest: digest } }),
        )
      }
      const tarball = join(root, 'future.tar.gz')
      await tarGz(artifact, tarball)
      for (const input of [artifact, tarball]) {
        await expect(classifyRestoreArtifact(input)).rejects.toThrow('cannot downgrade')
        await expect(classifyRestoreArtifact(input)).rejects.toThrow(
          'upgrade the binary or pick an older backup',
        )
      }
      expect(existsSync(join(root, 'database-migrations'))).toBeFalse()
    } finally {
      db.$client.close()
      removeTempDirSync(root)
    }
  })
