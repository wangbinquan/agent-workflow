// RFC-359 T19h — real historical SQLite receipts and rows cross the boot
// boundary before an existing generation pointer advances. PostgreSQL's real
// copy/upgrade/export lane lives in rfc359-t19h-postgresql-upgrade.integration.

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
  failDatabaseMigration,
  markDatabaseMigrationCancelled,
  requestDatabaseMigrationCancellation,
  type DatabaseMigrationPhase,
} from '@/modules/system-operations/domain/databaseMigration'
import {
  createDatabaseMigrationCoordinator,
  readDatabaseSchemaUpgradeGeneration,
} from '@/modules/system-operations/infrastructure/databaseMigrationCoordinator'
import {
  prepareDatabaseSchemaUpgrade,
  type DatabaseSchemaUpgradeOptions,
} from '@/modules/system-operations/infrastructure/databaseSchemaUpgradeCoordinator'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { createFileDatabaseMigrationArtifactStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore'
import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import {
  readDatabaseGeneration,
  digestDatabaseArtifact,
  digestGenerationPayload,
  writeDatabaseGenerationAtomic,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationStore'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import { readDbMigrationIdentity } from '@/platform/persistence/sqlite/systemBackupManifest'
import {
  restoreBackup,
  validateBackupForStage,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { openSqliteLogicalSourceWorker } from '@/platform/persistence/sqliteLogicalSourceWorkerSupervisor'
import { createPortableBackupArchive } from '@/services/portableBackupArchive'
import { acquireLock } from '@/util/lock'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const history = await loadPostgresqlMigrationHistory()
const templateRoot = mkdtempSync(join(tmpdir(), 'rfc359-old-schema-template-'))
const oldMigrations = join(templateRoot, 'migrations')
mkdirSync(join(oldMigrations, 'meta'), { recursive: true })
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string }[]
}
writeFileSync(
  join(oldMigrations, 'meta', '_journal.json'),
  JSON.stringify({
    ...journal,
    entries: journal.entries.slice(0, history.root.sqliteMigration.count),
  }),
)
for (const migration of history.root.sqliteMigrations) {
  copyFileSync(
    join(MIGRATIONS, `${migration.tag}.sql`),
    join(oldMigrations, `${migration.tag}.sql`),
  )
}
const template = createInMemoryDb(oldMigrations)
template.$client
  .query('INSERT INTO runtimes(id,name,protocol,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('t19h-runtime', 't19h-runtime', 'opencode', 'preserved-model', 17, 19)
const oldImage = template.$client.serialize()
const oldRow = template.$client.query('SELECT * FROM runtimes WHERE id = ?').get('t19h-runtime')
template.$client.close()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => rmSync(templateRoot, { recursive: true, force: true }))

function fixture(pointer = true, version: 'root' | 'head' = 'root') {
  const root = mkdtempSync(join(tmpdir(), 'rfc359-generation-upgrade-'))
  roots.push(root)
  const paths = {
    sqlitePath: join(root, 'db.sqlite'),
    generationPointerPath: join(root, 'database-generation.json'),
    operationsRoot: join(root, 'database-migrations'),
    lockPath: join(root, 'daemon.lock'),
  }
  writeFileSync(paths.sqlitePath, oldImage)
  if (version === 'head') {
    const current = createInMemoryDb(MIGRATIONS)
    try {
      writeFileSync(paths.sqlitePath, current.$client.serialize())
    } finally {
      current.$client.close()
    }
  }
  const payload: DatabaseGenerationPayload = {
    version: 1,
    provider: 'sqlite',
    generationId: 'dbg_t19h_sqlite_0001',
    operationId: null,
    schemaDigest: history[version].contract.digest,
    manifestDigest: null,
    activatedAt: 41,
  }
  if (pointer) writeDatabaseGenerationAtomic({ pointerPath: paths.generationPointerPath, payload })
  const options: DatabaseSchemaUpgradeOptions = {
    ...paths,
    config: { provider: 'sqlite' },
    contract: history.head.contract,
    history,
    sqliteOptions: { migrationsFolder: MIGRATIONS },
    readConfig: () => ({ provider: 'sqlite' }),
    writeConfig: () => {
      throw new Error('an SQLite schema upgrade must preserve config')
    },
  }
  return { root, paths, payload, options }
}

function indexes(path: string) {
  const db = new Database(path, { readonly: true })
  try {
    return db
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('idx_tasks_overview_counts','idx_tasks_cached_repo_task') ORDER BY name",
      )
      .all()
  } finally {
    db.close()
  }
}

/** Actual durable control-plane writes with an injected stop between the
 * manifest and pointer commits. The PostgreSQL database work is intentionally
 * outside this file-only checkpoint test and is covered by the hosted lane. */
function interruptedPointerFixture(version: 'root' | 'head' = 'root') {
  const base = fixture(true, version)
  const contract = history[version].contract
  const operationId = 'dbm_t19h_pointer_gap_0001'
  const generationId = `dbg_pg_${operationId.slice(4)}`
  let manifest = createDatabaseMigrationManifest({
    operationId,
    idempotencyKey: 't19h-pointer-gap-0001',
    sourceGenerationId: base.payload.generationId,
    sourceSchemaDigest: contract.digest,
    sourceDatabaseFingerprint: 'sqlite:checkpoint-source',
    target: {
      provider: 'postgresql',
      urlEnv: 'RFC349_DATABASE_URL',
      poolMax: 1,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    },
    tableCounts: {
      source: contract.sourceTableCount,
      active: contract.activeTableCount,
      archiveOnly: contract.archiveOnlyTableCount,
    },
    ownerId: 'dbo_t19h_checkpoint_0001',
    ownerLeaseExpiresAt: 30_000,
    now: 1,
  })
  const store = createFileDatabaseMigrationStore({ root: base.paths.operationsRoot })
  store.create(manifest)
  const artifacts = createFileDatabaseMigrationArtifactStore({
    operationsRoot: base.paths.operationsRoot,
  })
  const logicalDigest = `sha256:${'c'.repeat(64)}`
  const archiveDigest = `sha256:${'d'.repeat(64)}`
  const verificationDigest = artifacts.writeVerificationReceipt(operationId, {
    version: 1,
    operationId,
    sourceGenerationId: base.payload.generationId,
    sourceFingerprint: manifest.payload.source.databaseFingerprint,
    targetFingerprint: 'postgresql:checkpoint-target',
    schemaDigest: contract.digest,
    logicalBackupDigest: logicalDigest,
    legacyArchiveDigest: archiveDigest,
    activeTableCount: contract.activeTableCount,
    archiveOnlyTableCount: contract.archiveOnlyTableCount,
    verifiedAt: 8,
  })
  const phases: readonly DatabaseMigrationPhase[] = [
    'preflighted',
    'source-frozen',
    'backed-up',
    'target-prepared',
    'copying',
    'verifying',
    'cutover-prepared',
    'switched',
  ]
  for (const nextPhase of phases) {
    const next = advanceDatabaseMigration(manifest, {
      expectedRevision: manifest.payload.revision,
      expectedPhase: manifest.payload.phase,
      nextPhase,
      ownerId: manifest.payload.owner.id,
      ownerFence: manifest.payload.owner.fence,
      idempotencyKey: `checkpoint-${nextPhase}`,
      now: manifest.payload.updatedAt + 1,
      ...(nextPhase === 'preflighted'
        ? { targetDatabaseFingerprint: 'postgresql:checkpoint-target' }
        : {}),
      ...(nextPhase === 'backed-up' ? { sourceBackupDigest: `sha256:${'b'.repeat(64)}` } : {}),
      ...(nextPhase === 'verifying'
        ? { logicalBackupDigest: logicalDigest, legacyArchiveDigest: archiveDigest }
        : {}),
      ...(nextPhase === 'cutover-prepared' ? { verificationDigest } : {}),
    })
    store.compareAndSwap(
      { operationId, revision: manifest.payload.revision, digest: manifest.digest },
      next,
    )
    manifest = next
  }
  const pointer: DatabaseGenerationPayload = {
    ...base.payload,
    provider: 'postgresql',
    generationId,
    operationId,
    manifestDigest: artifacts.manifestFileDigest(operationId),
  }
  writeDatabaseGenerationAtomic({ pointerPath: base.paths.generationPointerPath, payload: pointer })
  const next = advanceDatabaseMigration(manifest, {
    expectedRevision: manifest.payload.revision,
    expectedPhase: 'switched',
    nextPhase: 'health-checked',
    ownerId: manifest.payload.owner.id,
    ownerFence: manifest.payload.owner.fence,
    idempotencyKey: 'checkpoint-health-checked',
    now: manifest.payload.updatedAt + 1,
  })
  const crash = new Error('stopped after durable manifest before pointer refresh')
  const faultStore = createFileDatabaseMigrationStore({
    root: base.paths.operationsRoot,
    afterReplaceForTest() {
      throw crash
    },
  })
  expect(() =>
    faultStore.compareAndSwap(
      { operationId, revision: manifest.payload.revision, digest: manifest.digest },
      next,
    ),
  ).toThrow(crash.message)
  return { ...base, operationId, pointer, store, manifest: next }
}

function completedPointerFixture(
  version: 'root' | 'head',
  phase: 'accepting-writes' | 'finalized',
) {
  const fixture = interruptedPointerFixture(version)
  const { paths, pointer, store, operationId } = fixture
  for (const nextPhase of ['accepting-writes', 'finalized'] as const) {
    const current = store.read(operationId)!
    const next = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase: current.payload.phase,
      nextPhase,
      ownerId: current.payload.owner.id,
      ownerFence: current.payload.owner.fence,
      idempotencyKey: `checkpoint-${nextPhase}`,
      now: current.payload.updatedAt + 1,
      ...(nextPhase === 'finalized' ? { receiptDigest: `sha256:${'e'.repeat(64)}` } : {}),
    })
    store.compareAndSwap(
      { operationId, revision: current.payload.revision, digest: current.digest },
      next,
    )
    if (nextPhase === phase) break
  }
  writeDatabaseGenerationAtomic({
    pointerPath: paths.generationPointerPath,
    payload: {
      ...pointer,
      manifestDigest: digestDatabaseArtifact(
        readFileSync(join(paths.operationsRoot, operationId, 'manifest.json')),
      ),
    },
  })
  return fixture
}

describe('RFC-359 T19h actual SQLite generation preparation', () => {
  test.each(['root', 'head'] as const)(
    'the real SQLite source Worker roundtrips the complete %s contract',
    async (version) => {
      const { paths, options } = fixture()
      if (version === 'head') {
        const prepared = await prepareDatabaseSchemaUpgrade(options)
        await prepared.runtime.close()
      }
      const contract = history[version].contract
      const direct = openSqliteLogicalSource({ path: paths.sqlitePath, contract })
      const worker = await openSqliteLogicalSourceWorker({ path: paths.sqlitePath, contract })
      try {
        const snapshot = await worker.preflight()
        expect(snapshot).toEqual(await direct.preflight())
        for (const table of contract.tables) {
          expect(await worker.readChunk(table, null, 100)).toEqual(
            await direct.readChunk(table, null, 100),
          )
        }
        await worker.assertUnchanged(snapshot)
        expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
          history[version].sqliteMigration.last.hash,
        )
      } finally {
        await worker.close()
        await direct.close()
      }
      await worker.close()
      await expect(worker.preflight()).rejects.toThrow('SQLite logical-source Worker is closed')
    },
  )

  test('an existing old pointer advances only after real DDL and keeps the same prepared client', async () => {
    const { paths, payload, options } = fixture()
    expect(() => resolveDatabaseProviderRuntime(options)).toThrow(
      'database generation schema digest does not match this binary',
    )
    expect(indexes(paths.sqlitePath)).toEqual([])
    const events: string[] = []
    const prepared = await prepareDatabaseSchemaUpgrade({
      ...options,
      beforeSqliteOpen() {
        expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
          history.root.sqliteMigration.last.hash,
        )
        expect(indexes(paths.sqlitePath)).toEqual([])
        expect(existsSync(paths.lockPath)).toBe(true)
        events.push('pre-backup')
      },
      beforePointerReplaceForTest() {
        expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
          history.head.sqliteMigration.last.hash,
        )
        events.push('pointer')
      },
    })
    if (prepared.provider !== 'sqlite') throw new Error('expected the original SQLite provider')
    try {
      const client = prepared.runtime.openClient({ migrationsFolder: MIGRATIONS })
      expect(prepared.runtime.openClient({ migrationsFolder: '/unused-after-preparation' })).toBe(
        client,
      )
      expect(
        client.$client.query('SELECT * FROM runtimes WHERE id = ?').get('t19h-runtime'),
      ).toEqual(oldRow)
      expect(indexes(paths.sqlitePath)).toEqual([
        { name: 'idx_tasks_cached_repo_task' },
        { name: 'idx_tasks_overview_counts' },
      ])
      expect(
        readDatabaseGeneration({
          pointerPath: paths.generationPointerPath,
          migrationsDir: paths.operationsRoot,
          expectedSchemaDigest: history.head.contract.digest,
        }).payload,
      ).toEqual({ ...payload, schemaDigest: history.head.contract.digest })
      expect(events).toEqual(['pre-backup', 'pointer'])
      expect(existsSync(paths.lockPath)).toBe(false)
    } finally {
      await prepared.runtime.close()
    }
  })

  test('a committed SQLite upgrade survives pointer-write failure and retries only the file commit', async () => {
    const { paths, options } = fixture()
    const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
    const failure = new Error('pointer replace interrupted')
    await expect(
      prepareDatabaseSchemaUpgrade({
        ...options,
        beforePointerReplaceForTest() {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
    expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
      history.head.sqliteMigration.last.hash,
    )
    expect(existsSync(paths.lockPath)).toBe(false)
    const committedImage = readFileSync(paths.sqlitePath)
    const prepared = await prepareDatabaseSchemaUpgrade(options)
    try {
      expect(prepared.runtime.generation.payload.schemaDigest).toBe(history.head.contract.digest)
    } finally {
      await prepared.runtime.close()
    }
    expect(readFileSync(paths.sqlitePath)).toEqual(committedImage)
  })

  test('after-replace failure leaves the completed pointer and the next boot performs no replacement', async () => {
    const { paths, options } = fixture()
    const failure = new Error('process stopped after pointer replace')
    await expect(
      prepareDatabaseSchemaUpgrade({
        ...options,
        afterPointerReplaceForTest() {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    const completedPointer = readFileSync(paths.generationPointerPath, 'utf8')
    const prepared = await prepareDatabaseSchemaUpgrade({
      ...options,
      beforePointerReplaceForTest() {
        throw new Error('unexpected pointer rewrite')
      },
    })
    await prepared.runtime.close()
    expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(completedPointer)
  })

  test('an existing current database with a legacy missing pointer keeps that pointer absent', async () => {
    const { paths, options } = fixture(false)
    const first = await prepareDatabaseSchemaUpgrade(options)
    await first.runtime.close()
    const second = await prepareDatabaseSchemaUpgrade(options)
    try {
      expect(second.runtime.generation.source).toBe('legacy-missing-pointer')
      expect(second.runtime.generation.payload.generationId).toBe('dbg_legacy_sqlite')
      expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
        history.head.sqliteMigration.last.hash,
      )
      expect(existsSync(paths.generationPointerPath)).toBe(false)
    } finally {
      await second.runtime.close()
    }
  })

  test('boot keeps the caller-owned daemon lock through preparation and application lifetime', async () => {
    const { paths, options } = fixture()
    const lock = acquireLock(paths.lockPath)
    try {
      const prepared = await prepareDatabaseSchemaUpgrade({ ...options, lock })
      await prepared.runtime.close()
      expect(existsSync(paths.lockPath)).toBe(true)
    } finally {
      lock.release()
    }
    expect(existsSync(paths.lockPath)).toBe(false)
  })

  test('a historical raw-plus-logical backup stages and restores before forward migration and pointer advancement', async () => {
    const { root, paths, options } = fixture()
    const backupApp = join(root, 'old-backup-app')
    mkdirSync(backupApp)
    const assetDatabase = createInMemoryDb(oldMigrations)
    const archive = await createPortableBackupArchive({
      appHome: backupApp,
      now: 123,
      application: createPortableBackupApplicationAssets({ db: assetDatabase }),
      async exportDatabase({ stagingDirectory, logicalArtifactRoot, operationId }) {
        const rawPath = join(stagingDirectory, 'db.sqlite')
        writeFileSync(rawPath, oldImage)
        const source = openSqliteLogicalSource({ path: rawPath, contract: history.root.contract })
        try {
          const snapshot = await source.preflight()
          const receipt = await exportLogicalDatabaseArtifact({
            operationId,
            sourceProvider: 'sqlite',
            sourceGenerationId: 'dbg_t19h_old_backup',
            contract: history.root.contract,
            artifactRoot: logicalArtifactRoot,
            expectedTableRows: snapshot.tableRows,
            source: {
              provider: 'sqlite',
              assertUnchanged: () => source.assertUnchanged(snapshot),
              readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
            },
            now: () => 123,
          })
          return {
            migration: {
              lastHash: history.root.sqliteMigration.last.hash,
              lastCreatedAt: history.root.sqliteMigration.last.folderMillis,
            },
            database: {
              format: 'agent-workflow-logical-database-v1',
              provider: 'sqlite',
              sourceGenerationId: 'dbg_t19h_old_backup',
              schemaDigest: history.root.contract.digest,
              logicalPath: 'database/logical',
              envelopeFileDigest: receipt.envelopeFileDigest,
              rawSqlitePath: 'db.sqlite',
            },
          }
        } finally {
          await source.close()
        }
      },
    }).finally(() => assetDatabase.$client.close())
    const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
    const originalArchive = readFileSync(archive.path)
    const plan = await validateBackupForStage(archive.path, {
      appHome: root,
      migrationsFolder: MIGRATIONS,
    })
    expect(plan.direction).toBe('forward')
    expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
      history.root.sqliteMigration.last.hash,
    )
    expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
    const events: string[] = []
    const restored = await restoreBackup(archive.path, {
      appHome: root,
      dbPath: paths.sqlitePath,
      migrationsFolder: MIGRATIONS,
      noSafetyBackup: true,
      __afterSwapForTest() {
        events.push('swap')
        expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
          history.root.sqliteMigration.last.hash,
        )
      },
      postOpenRecovery: {
        async recover({ db }) {
          events.push('recovery')
          expect(
            db.$client.query('SELECT * FROM runtimes WHERE id = ?').get('t19h-runtime'),
          ).toEqual(oldRow)
          expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
            history.head.sqliteMigration.last.hash,
          )
        },
      },
    })
    expect(restored).toMatchObject({ direction: 'forward', migrated: true, restored: { db: true } })
    expect(events).toEqual(['swap', 'recovery'])
    expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
    const prepared = await prepareDatabaseSchemaUpgrade(options)
    await prepared.runtime.close()
    expect(
      readDatabaseGeneration({
        pointerPath: paths.generationPointerPath,
        migrationsDir: paths.operationsRoot,
        expectedSchemaDigest: history.head.contract.digest,
      }).payload.schemaDigest,
    ).toBe(history.head.contract.digest)
    expect(readFileSync(archive.path)).toEqual(originalArchive)
  })

  test.each(['failed', 'cancelled', 'cancel-requested'] as const)(
    '%s historical copy requires explicit resume before any source or target migration',
    async (state) => {
      const { paths, payload, options } = fixture()
      let manifest = createDatabaseMigrationManifest({
        operationId: `dbm_t19h_${state}_0001`,
        idempotencyKey: `t19h-${state}-0001`,
        sourceGenerationId: payload.generationId,
        sourceSchemaDigest: history.root.contract.digest,
        sourceDatabaseFingerprint: 'sqlite:preserved-source',
        target: {
          provider: 'postgresql',
          urlEnv: 'RFC349_DATABASE_URL',
          poolMax: 1,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
        tableCounts: {
          source: history.root.contract.sourceTableCount,
          active: history.root.contract.activeTableCount,
          archiveOnly: history.root.contract.archiveOnlyTableCount,
        },
        ownerId: 'dbo_t19h_fixture_0001',
        ownerLeaseExpiresAt: 30_000,
        now: 1,
      })
      const authority = () => ({
        expectedRevision: manifest.payload.revision,
        ownerId: manifest.payload.owner.id,
        ownerFence: manifest.payload.owner.fence,
      })
      if (state === 'failed') {
        manifest = failDatabaseMigration(manifest, {
          ...authority(),
          category: 'target-schema',
          detailCode: 'target-test-failed',
          retryable: true,
          retryCount: 0,
          nextRetryAt: null,
          now: 2,
        })
      } else {
        manifest = requestDatabaseMigrationCancellation(manifest, { ...authority(), now: 2 })
        if (state === 'cancelled') {
          manifest = markDatabaseMigrationCancelled(manifest, { ...authority(), now: 3 })
        }
      }
      const store = createFileDatabaseMigrationStore({ root: paths.operationsRoot })
      store.create(manifest)
      const originalDatabase = readFileSync(paths.sqlitePath)
      const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
      await expect(
        prepareDatabaseSchemaUpgrade({
          ...options,
          beforeSqliteOpen() {
            throw new Error('must not open/migrate source')
          },
          postgresqlPoolFactory() {
            throw new Error('must not open/migrate target')
          },
        }),
      ).rejects.toMatchObject({ code: 'database-migration-resume-required' })
      expect(store.read(manifest.payload.operationId)).toEqual(manifest)
      expect(readFileSync(paths.sqlitePath)).toEqual(originalDatabase)
      expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
      expect(existsSync(paths.lockPath)).toBe(false)
      const coordinator = createDatabaseMigrationCoordinator({
        ...paths,
        contract: history.head.contract,
        admission: {
          async freezeAndDrain() {},
          async reopenSqlite() {},
          async activatePostgresql() {},
          async openPostgresqlAdmission() {},
        },
        activateTargetConfig() {},
        activateSourceConfig() {},
        interruptedOperationId: 'dbm_t19h_other_operation',
      })
      expect(await coordinator.get({ operationId: manifest.payload.operationId })).toMatchObject({
        operationId: manifest.payload.operationId,
        failure: manifest.payload.failure,
        resumeEligible: state !== 'cancel-requested',
      })
      expect(await coordinator.resumeInterrupted(manifest.payload.target)).toBeNull()
      expect(store.read(manifest.payload.operationId)).toEqual(manifest)
    },
  )
})

describe('RFC-359 T19h interrupted copy pointer discovery', () => {
  test('a durable manifest commit becomes a recovery candidate, never a strict runtime generation', () => {
    const { paths, options, pointer, store, manifest, operationId } = interruptedPointerFixture()
    const beforePointer = readFileSync(paths.generationPointerPath, 'utf8')
    const beforeDatabase = readFileSync(paths.sqlitePath)
    expect(store.read(operationId)).toEqual(manifest)
    expect(() =>
      readDatabaseGeneration({
        pointerPath: paths.generationPointerPath,
        migrationsDir: paths.operationsRoot,
        expectedSchemaDigest: history.root.contract.digest,
      }),
    ).toThrow('database generation manifest digest mismatch')
    const candidate = readDatabaseSchemaUpgradeGeneration({ ...options, history })
    expect(candidate).toEqual({
      kind: 'operation-recovery',
      payload: pointer,
      pointerDigest: digestGenerationPayload(pointer),
      recoveryManifestDigest: digestDatabaseArtifact(
        readFileSync(join(paths.operationsRoot, operationId, 'manifest.json')),
      ),
    })
    expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(beforePointer)
    expect(readFileSync(paths.sqlitePath)).toEqual(beforeDatabase)
  })

  test('the recovery candidate requires the recorded target generation and original verification receipt', () => {
    const { paths, options, pointer, operationId } = interruptedPointerFixture()
    writeDatabaseGenerationAtomic({
      pointerPath: paths.generationPointerPath,
      payload: { ...pointer, generationId: 'dbg_t19h_wrong_target' },
    })
    expect(() => readDatabaseSchemaUpgradeGeneration({ ...options, history })).toThrow(
      'does not identify a recoverable copy checkpoint',
    )
    writeDatabaseGenerationAtomic({ pointerPath: paths.generationPointerPath, payload: pointer })
    writeFileSync(join(paths.operationsRoot, operationId, 'verification.json'), '{}')
    expect(() => readDatabaseSchemaUpgradeGeneration({ ...options, history })).toThrow(
      'verification file digest',
    )
  })

  test('an interrupted pointer cannot turn a subsequently failed copy into automatic resume', async () => {
    const { paths, options, store, manifest, operationId } = interruptedPointerFixture()
    const failed = failDatabaseMigration(manifest, {
      expectedRevision: manifest.payload.revision,
      ownerId: manifest.payload.owner.id,
      ownerFence: manifest.payload.owner.fence,
      category: 'health-failed',
      detailCode: 'retained-failure',
      retryable: true,
      retryCount: 0,
      nextRetryAt: null,
      now: manifest.payload.updatedAt + 1,
    })
    store.compareAndSwap(
      { operationId, revision: manifest.payload.revision, digest: manifest.digest },
      failed,
    )
    await expect(
      prepareDatabaseSchemaUpgrade({
        ...options,
        postgresqlPoolFactory() {
          throw new Error('must not construct target')
        },
      }),
    ).rejects.toMatchObject({ code: 'database-migration-resume-required' })
    expect(store.read(operationId)).toEqual(failed)
    expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
      history.root.sqliteMigration.last.hash,
    )
  })

  test.each([
    ['root', 'stale-link'],
    ['root', 'refreshed-link'],
    ['head', 'stale-link'],
    ['head', 'refreshed-link'],
  ] as const)(
    'explicit resume of the same failed PostgreSQL generation reaches its real target setup (%s/%s)',
    async (version, link) => {
      const { paths, options, store, manifest, operationId, pointer } =
        interruptedPointerFixture(version)
      const failed = failDatabaseMigration(manifest, {
        expectedRevision: manifest.payload.revision,
        ownerId: manifest.payload.owner.id,
        ownerFence: manifest.payload.owner.fence,
        category: 'health-failed',
        detailCode: 'retained-failure',
        retryable: true,
        retryCount: 0,
        nextRetryAt: null,
        now: manifest.payload.updatedAt + 1,
      })
      store.compareAndSwap(
        { operationId, revision: manifest.payload.revision, digest: manifest.digest },
        failed,
      )
      if (link === 'refreshed-link') {
        writeDatabaseGenerationAtomic({
          pointerPath: paths.generationPointerPath,
          payload: {
            ...pointer,
            manifestDigest: digestDatabaseArtifact(
              readFileSync(join(paths.operationsRoot, operationId, 'manifest.json')),
            ),
          },
        })
      }
      const oldPointer = readFileSync(paths.generationPointerPath, 'utf8')
      await expect(prepareDatabaseSchemaUpgrade(options)).rejects.toMatchObject({
        code: 'database-migration-resume-required',
      })
      const coordinator = createDatabaseMigrationCoordinator({
        ...paths,
        contract: history.head.contract,
        env: {},
        admission: {
          async freezeAndDrain() {},
          async reopenSqlite() {},
          async activatePostgresql() {},
          async openPostgresqlAdmission() {},
        },
        activateTargetConfig() {},
        activateSourceConfig() {},
      })
      // The original public resume stopped at source-not-sqlite (or the stale
      // file link). The same command now validates this exact operation and
      // reaches the actual PostgreSQL mechanism, whose URL is deliberately
      // absent here. No server, fake successful target or business result.
      await expect(coordinator.resume({ operationId })).rejects.toMatchObject({
        code: 'postgresql-url-env-missing',
      })
      expect(store.read(operationId)).toEqual(failed)
      expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(oldPointer)
      expect(readDbMigrationIdentity(paths.sqlitePath)?.lastHash).toBe(
        history[version].sqliteMigration.last.hash,
      )
      writeDatabaseGenerationAtomic({
        pointerPath: paths.generationPointerPath,
        payload: { ...pointer, generationId: 'dbg_t19h_different_target' },
      })
      await expect(coordinator.resume({ operationId })).rejects.toMatchObject({
        code: 'generation-manifest-digest-mismatch',
      })
    },
  )

  test.each(['root', 'head'] as const)(
    'a healthy completed %s target keeps the original public resume rejection',
    async (version) => {
      for (const phase of ['accepting-writes', 'finalized'] as const) {
        const { paths, store, operationId } = completedPointerFixture(version, phase)
        const originalManifest = store.read(operationId)
        const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
        const originalDatabase = readFileSync(paths.sqlitePath)
        const coordinator = createDatabaseMigrationCoordinator({
          ...paths,
          contract: history.head.contract,
          env: {},
          admission: {
            async freezeAndDrain() {
              throw new Error('completed operation must not freeze the source')
            },
            async reopenSqlite() {},
            async activatePostgresql() {},
            async openPostgresqlAdmission() {},
          },
          activateTargetConfig() {},
          activateSourceConfig() {},
        })
        await expect(coordinator.resume({ operationId })).rejects.toMatchObject({
          code: 'database-migration-source-not-sqlite',
          message: 'one-click migration requires the live database generation to be SQLite',
        })
        expect(store.read(operationId)).toEqual(originalManifest)
        expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
        expect(readFileSync(paths.sqlitePath)).toEqual(originalDatabase)
      }
    },
  )

  test.each(['accepting-writes', 'finalized'] as const)(
    'a current %s target preserves its historical copy receipt without taking the daemon lock',
    async (phase) => {
      const { paths, options, pointer, store, operationId } = completedPointerFixture('root', phase)
      const completed = store.read(operationId)!
      writeDatabaseGenerationAtomic({
        pointerPath: paths.generationPointerPath,
        payload: {
          ...pointer,
          schemaDigest: history.head.contract.digest,
          manifestDigest: digestDatabaseArtifact(
            readFileSync(join(paths.operationsRoot, operationId, 'manifest.json')),
          ),
        },
      })
      const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
      const lock = acquireLock(paths.lockPath)
      try {
        // A ready target still performs actual schema readiness checks. The
        // deliberately absent URL stops before opening any PostgreSQL socket;
        // an unnecessary copy/DDL file lock would fail earlier with LockError.
        await expect(
          prepareDatabaseSchemaUpgrade({ ...options, config: completed.payload.target, env: {} }),
        ).rejects.toMatchObject({ code: 'postgresql-url-env-missing' })
        expect(existsSync(paths.lockPath)).toBe(true)
        expect(store.read(operationId)).toEqual(completed)
        expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
      } finally {
        lock.release()
      }
    },
  )

  test.each(['root', 'head'] as const)(
    'boot resumes the exact healthy interrupted %s target before schema preparation',
    async (version) => {
      const { paths, options, pointer, store, manifest, operationId } =
        interruptedPointerFixture(version)
      writeDatabaseGenerationAtomic({
        pointerPath: paths.generationPointerPath,
        payload: {
          ...pointer,
          manifestDigest: digestDatabaseArtifact(
            readFileSync(join(paths.operationsRoot, operationId, 'manifest.json')),
          ),
        },
      })
      const originalPointer = readFileSync(paths.generationPointerPath, 'utf8')
      const originalDatabase = readFileSync(paths.sqlitePath)
      const startedAt = Date.now()
      await expect(
        prepareDatabaseSchemaUpgrade({
          ...options,
          env: {},
          beforeSqliteOpen() {
            throw new Error('copy must recover before source migration')
          },
          postgresqlPoolFactory() {
            throw new Error('copy must recover before target schema migration')
          },
        }),
      ).rejects.toMatchObject({ code: 'postgresql-url-env-missing' })
      const failed = store.read(operationId)!
      const failure = failed.payload.failure
      if (failure === null) throw new Error('actual target construction failure was not recorded')
      expect(failure).toEqual({
        category: 'cutover-failed',
        detailCode: 'postgresql-url-env-missing',
        phase: 'health-checked',
        retryable: false,
        retryCount: 0,
        nextRetryAt: null,
        failedAt: failure.failedAt,
      })
      expect(failure.failedAt).toBeGreaterThanOrEqual(startedAt)
      expect(failure.failedAt).toBeLessThanOrEqual(Date.now())
      expect(failed.payload).toEqual({
        ...manifest.payload,
        revision: manifest.payload.revision + 1,
        previousDigest: manifest.digest,
        failure,
        updatedAt: failure.failedAt,
      })
      await expect(prepareDatabaseSchemaUpgrade(options)).rejects.toMatchObject({
        code: 'database-migration-resume-required',
      })
      expect(store.read(operationId)).toEqual(failed)
      expect(readFileSync(paths.generationPointerPath, 'utf8')).toBe(originalPointer)
      expect(readFileSync(paths.sqlitePath)).toEqual(originalDatabase)
      expect(existsSync(paths.lockPath)).toBe(false)
    },
  )
})
