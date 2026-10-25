// Released epoch-1 defect: users:presence grants were rejected as invalid JSON during backups.
// User decision (2026-10-24): fix epoch 1 now, including boot upgrades and historical restores.
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createInMemoryDb } from '@/db/client'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
  serializeDatabaseMigrationManifest,
  type DatabaseMigrationPhase,
} from '@/modules/system-operations/domain/databaseMigration'
import { prepareDatabaseSchemaUpgrade } from '@/modules/system-operations/infrastructure/databaseSchemaUpgradeCoordinator'
import { createPostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import { restorePostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderRestore'
import {
  digestDatabaseArtifact,
  readDatabaseGeneration,
  readDatabaseGenerationForBootstrap,
  writeDatabaseGenerationAtomic,
} from '@/platform/persistence/generationStore'
import { decodeLogicalRow } from '@/platform/persistence/logicalDatabaseArtifact'
import {
  exportLogicalDatabaseArtifact,
  readLogicalDatabaseBackupEnvelope,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  restoreLogicalDatabaseBackup,
} from '@/platform/persistence/logicalDatabaseRestore'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import {
  activateHostedPostgresqlGeneration,
  migratePostgresqlSchema,
} from '@/platform/persistence/postgresqlMigrator'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { createBackup } from '@/platform/persistence/sqlite/systemProviderBackup'
import { restoreBackup } from '@/platform/persistence/sqlite/systemProviderRestore'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { readManifest } from '@/services/backupManifest'
import { extractTarGz } from '@/util/archive'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'
import { freezeAt, MIGRATIONS } from './migration-freeze'

setDefaultTimeout(180_000)
const roots: string[] = []
const operationId = 'dbm_epoch1_permission_text'
const generationId = 'dbg_pg_epoch1_permission_text'
const userId = 'epoch1-permission-user'
const permission = 'users:presence'
const contract = buildLogicalSchemaContract()
let history: PostgresqlMigrationHistory
beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory({ headContract: contract })
})
afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'epoch1-permission-text-'))
  roots.push(root)
  return root
}
function seedStatements(prefix = ''): string[] {
  return [
    `INSERT INTO ${prefix}users (id, username, display_name, role, created_at, updated_at) VALUES ('${userId}', 'permission-user', 'Permission user', 'user', 1, 1)`,
    `INSERT INTO ${prefix}user_permission_grants (user_id, permission, granted_at) VALUES ('${userId}', '${permission}', 1)`,
  ]
}

async function preservedMigration(
  appHome: string,
  previous: LogicalSchemaContract,
  config: Extract<DatabaseConfig, { provider: 'postgresql' }>,
) {
  const artifactRoot = join(appHome, 'database-migrations', operationId)
  const artifact = await exportLogicalDatabaseArtifact({
    operationId,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_epoch1_permission_source',
    contract: previous,
    artifactRoot,
    expectedTableRows: Object.fromEntries(previous.tables.map((table) => [table.id, 0])),
    source: {
      provider: 'sqlite',
      async assertUnchanged() {},
      async readChunk() {
        return []
      },
    },
    now: () => 1,
  })
  let manifest = createDatabaseMigrationManifest({
    operationId,
    idempotencyKey: 'epoch1-permission-migration',
    sourceGenerationId: 'dbg_epoch1_permission_source',
    sourceSchemaDigest: previous.digest,
    sourceDatabaseFingerprint: 'sqlite:permission-fixture',
    target: config,
    ownerId: 'dbo_epoch1_permission_owner',
    ownerLeaseExpiresAt: 60_000,
    tableCounts: {
      source: previous.sourceTableCount,
      active: previous.activeTableCount,
      archiveOnly: previous.archiveOnlyTableCount,
    },
    now: 1,
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
    'health-checked',
    'accepting-writes',
  ]
  for (const nextPhase of phases)
    manifest = advanceDatabaseMigration(manifest, {
      expectedRevision: manifest.payload.revision,
      expectedPhase: manifest.payload.phase,
      nextPhase,
      ownerId: manifest.payload.owner.id,
      ownerFence: manifest.payload.owner.fence,
      idempotencyKey: `permission-${nextPhase}`,
      now: manifest.payload.updatedAt + 1,
      ...(nextPhase === 'preflighted'
        ? { targetDatabaseFingerprint: 'pg:permission-fixture' }
        : {}),
      ...(nextPhase === 'backed-up' ? { sourceBackupDigest: artifact.envelopeFileDigest } : {}),
      ...(nextPhase === 'verifying'
        ? {
            logicalBackupDigest: artifact.envelope.payload.logicalManifestDigest,
            legacyArchiveDigest: artifact.envelope.payload.legacyArchiveFileDigest,
          }
        : {}),
      ...(nextPhase === 'cutover-prepared'
        ? { verificationDigest: artifact.envelopeFileDigest }
        : {}),
    })
  const bytes = serializeDatabaseMigrationManifest(manifest)
  writeFileSync(join(artifactRoot, 'manifest.json'), bytes)
  return digestDatabaseArtifact(bytes)
}

describeEachProvider('epoch-1 permission text boot and provider backup', (harness) => {
  test('upgrades the previous head, backs up users:presence and restores its exact text', async () => {
    const appHome = tempRoot()
    const pointerPath = join(appHome, 'database-generation.json')
    const operationsRoot = join(appHome, 'database-migrations')
    const sqlitePath = join(appHome, 'db.sqlite')
    const previous = history.versions.at(-2)!
    const binding = harness.applicationBinding
    const config: DatabaseConfig =
      binding.provider === 'sqlite' ? { provider: 'sqlite' } : binding.databaseConfig
    let manifestDigest: string | null = null
    if (binding.provider === 'sqlite') {
      const prefix = freezeAt(previous.sqliteMigration.last.index)
      roots.push(prefix)
      const db = createInMemoryDb(prefix)
      try {
        for (const statement of seedStatements()) db.$client.exec(statement)
        writeFileSync(sqlitePath, db.$client.serialize())
      } finally {
        db.$client.close()
      }
    } else {
      const runtime = createPostgresqlDatabaseRuntime({
        config: binding.databaseConfig,
        generationId,
      })
      try {
        await harness.executeFixtureDdl('DROP SCHEMA agent_workflow CASCADE')
        await harness.executeFixtureDdl('DROP SCHEMA agent_workflow_meta CASCADE')
        await migratePostgresqlSchema({ runtime, headContract: contract, plan: previous.plan })
        for (const statement of seedStatements('agent_workflow.'))
          await runtime.providerPool().unsafe(statement)
        await activateHostedPostgresqlGeneration({
          runtime,
          generation: { generationId, operationId },
          contractDigest: previous.contract.digest,
          planDigest: previous.plan.digest,
          now: 1,
        })
        manifestDigest = await preservedMigration(
          appHome,
          previous.contract,
          binding.databaseConfig,
        )
      } finally {
        await runtime.close()
      }
    }
    writeDatabaseGenerationAtomic({
      pointerPath,
      payload: {
        version: 1,
        provider: binding.provider,
        generationId,
        schemaDigest: previous.contract.digest,
        operationId: binding.provider === 'sqlite' ? null : operationId,
        manifestDigest,
        activatedAt: 1,
      },
    })
    expect(
      readDatabaseGenerationForBootstrap({
        pointerPath,
        migrationsDir: operationsRoot,
        expectedSchemaDigest: contract.digest,
        supportedSchemaDigests: history.versions.map((version) => version.contract.digest),
      }).kind,
    ).toBe('schema-upgrade')
    const prepare = () =>
      prepareDatabaseSchemaUpgrade({
        config,
        sqlitePath,
        generationPointerPath: pointerPath,
        operationsRoot,
        contract,
        history,
        sqliteOptions: { migrationsFolder: MIGRATIONS },
        lockPath: join(appHome, 'schema-upgrade.lock'),
        readConfig: () => config,
        writeConfig: () => {
          throw new Error('codec correction must retain provider config')
        },
      })
    let backupPath: string
    const prepared = await prepare()
    try {
      expect(
        readDatabaseGeneration({
          pointerPath,
          migrationsDir: operationsRoot,
          expectedSchemaDigest: contract.digest,
        }).payload,
      ).toMatchObject({ generationId, schemaDigest: contract.digest, activatedAt: 1 })
      if (prepared.provider === 'sqlite') {
        const db = prepared.runtime.openClient({ migrationsFolder: MIGRATIONS })
        expect(db.$client.query('SELECT permission FROM user_permission_grants').all()).toEqual([
          { permission },
        ])
        expect(
          db.$client.query('SELECT count(*) AS count FROM __drizzle_migrations').get(),
        ).toEqual({ count: 262 })
        backupPath = (await createBackup({ db, contract, appHome, now: 2 })).path
      } else {
        expect(prepared.receipt.applied).toBe(true)
        const runtime = prepared.runtime.runtime
        expect(
          await runtime
            .providerPool()
            .unsafe(
              "SELECT contract_digest FROM agent_workflow_meta.database_generations WHERE state='active'",
            ),
        ).toEqual([expect.objectContaining({ contract_digest: contract.digest })])
        expect(
          await runtime
            .providerPool()
            .unsafe(
              "SELECT baseline_id FROM agent_workflow_meta.schema_migrations WHERE baseline_id LIKE 'upgrade:%'",
            ),
        ).toEqual([
          expect.objectContaining({
            baseline_id: `upgrade:0038_epoch1_permission_text:${history.steps.at(-1)!.digest}`,
          }),
        ])
        backupPath = (
          await createPostgresqlProviderBackup({
            headContract: contract,
            contract,
            appHome,
            runtime,
            now: 2,
            application: {
              async exportWorkflows() {
                return 0
              },
              async captureWorktrees() {},
            },
          })
        ).path
      }
    } finally {
      await prepared.runtime.close()
    }
    const restarted = await prepare()
    try {
      if (restarted.provider === 'postgresql') expect(restarted.receipt.applied).toBe(false)
    } finally {
      await restarted.runtime.close()
    }

    const extracted = tempRoot()
    await extractTarGz(backupPath, extracted)
    const manifest = readManifest(extracted)
    if (manifest?.manifestVersion !== 2) throw new Error('expected logical backup manifest')
    const artifactRoot = join(extracted, manifest.database.logicalPath)
    const envelope = readLogicalDatabaseBackupEnvelope({
      artifactRoot,
      expectedFileDigest: manifest.database.envelopeFileDigest,
    })
    const source = openVerifiedLogicalDatabaseArtifactSource({
      artifactRoot,
      expectedManifestDigest: envelope.payload.logicalManifestDigest,
      expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
      contract,
    })
    const grants = contract.tables.find((table) => table.id === 'user_permission_grants')!
    expect(
      source.readChunk(grants, 0).payload.rows.map((row) => decodeLogicalRow(grants, row)),
    ).toEqual([{ user_id: userId, permission, granted_by_user_id: null, granted_at: 1 }])

    if (binding.provider === 'sqlite') {
      const restoredHome = tempRoot()
      await restoreBackup(backupPath, {
        contract,
        appHome: restoredHome,
        migrationsFolder: MIGRATIONS,
        noSafetyBackup: true,
        postOpenRecovery: { async recover() {} },
      })
      const restored = new Database(join(restoredHome, 'db.sqlite'))
      try {
        expect(restored.query('SELECT permission FROM user_permission_grants').all()).toEqual([
          { permission },
        ])
      } finally {
        restored.close()
      }
    } else {
      await harness.executeFixtureDdl('DROP SCHEMA agent_workflow CASCADE')
      await harness.executeFixtureDdl('DROP SCHEMA agent_workflow_meta CASCADE')
      const runtime = createPostgresqlDatabaseRuntime({
        config: binding.databaseConfig,
        generationId,
      })
      try {
        await restorePostgresqlProviderBackup({
          headContract: contract,
          contract,
          plan: history.head.plan,
          tarballPath: backupPath,
          appHome: tempRoot(),
          restoreOperationId: 'dbm_epoch1_permission_restore',
          runtime,
          filesystem: { async apply() {} },
        })
        expect(
          await runtime
            .providerPool()
            .unsafe('SELECT permission FROM agent_workflow.user_permission_grants'),
        ).toEqual([expect.objectContaining({ permission })])
      } finally {
        await runtime.close()
      }
    }
  })
})

describe('epoch-1 historical logical backup', () => {
  if (resolveTestProviders(process.env).includes('sqlite'))
    test('restores the previous contract using its original JSON codec and preserves stored text', async () => {
      const previous = history.versions.at(-2)!
      const prefix = freezeAt(previous.sqliteMigration.last.index)
      roots.push(prefix)
      const db = createInMemoryDb(prefix)
      const appHome = tempRoot()
      const sourcePath = join(appHome, 'old.sqlite')
      try {
        db.$client.exec(seedStatements()[0]!)
        // A backup accepted by the old codec can contain JSON text; its bytes must stay intact.
        db.$client
          .query(
            'INSERT INTO user_permission_grants (user_id, permission, granted_at) VALUES (?, ?, 1)',
          )
          .run(userId, JSON.stringify(permission))
        writeFileSync(sourcePath, db.$client.serialize())
      } finally {
        db.$client.close()
      }
      const source = openSqliteLogicalSource({ path: sourcePath, contract: previous.contract })
      const artifactRoot = join(appHome, 'logical')
      try {
        const snapshot = await source.preflight()
        const exported = await exportLogicalDatabaseArtifact({
          operationId,
          sourceProvider: 'sqlite',
          sourceGenerationId: generationId,
          contract: previous.contract,
          artifactRoot,
          expectedTableRows: snapshot.tableRows,
          source: {
            provider: 'sqlite',
            assertUnchanged: () => source.assertUnchanged(snapshot),
            readChunk: (table, key, limit) => source.readChunk(table, key, limit),
          },
        })
        const restored = new Database(':memory:')
        restored.exec(
          'CREATE TABLE user_permission_grants (user_id text, permission text, granted_by_user_id text, granted_at integer)',
        )
        try {
          await restoreLogicalDatabaseBackup({
            headContract: contract,
            contract: previous.contract,
            targetContract: contract,
            artifactRoot,
            expectedEnvelopeFileDigest: exported.envelopeFileDigest,
            restoreOperationId: 'dbm_epoch1_historical_restore',
            target: {
              provider: 'sqlite',
              operationId: 'dbm_epoch1_historical_restore',
              async prepare() {},
              async copyChunk(table, chunk) {
                if (table.id !== 'user_permission_grants') return
                for (const row of chunk.payload.rows) {
                  const decoded = decodeLogicalRow(table, row)
                  restored
                    .query('INSERT INTO user_permission_grants (user_id, permission) VALUES (?, ?)')
                    .run(String(decoded.user_id), String(decoded.permission))
                }
              },
              async finalizeSchema() {},
            },
          })
          expect(restored.query('SELECT permission FROM user_permission_grants').all()).toEqual([
            { permission: JSON.stringify(permission) },
          ])
        } finally {
          restored.close()
        }
      } finally {
        await source.close()
      }
    })
})
