import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackupManifestV2 } from '../src/services/backupManifest'
import type { PostgresqlDatabaseRuntime } from '../src/platform/persistence/postgresqlRuntime'
import { PostgresqlPreflightError } from '../src/platform/persistence/postgresqlPreflight'
import type { LogicalSchemaContract } from '../src/platform/persistence/schemaContract'
import type { PostgresqlSchemaPlan } from '../src/platform/persistence/postgresqlSchema'
import { DomainError } from '../src/util/errors'
import {
  createPostgresqlAdminRestoreCoordinator,
  type CreatePostgresqlAdminRestoreCoordinatorInput,
} from '../src/modules/system-operations/infrastructure/postgresqlAdminRestoreCoordinator'
import type {
  PortableDatabaseBackupInspection,
  PortableDatabaseRestoreResult,
} from '../src/modules/system-operations/infrastructure/portableDatabaseRestore'
import type { RestoreArtifactRef } from '../src/modules/system-operations/public/types'

const ENVELOPE_DIGEST = `sha256:${'a'.repeat(64)}`
const RESTORE_OPERATION = `dbm_restore_${'a'.repeat(32)}`
const GENERATION = 'dbg_postgresql_restore_01'

function inspection(): PortableDatabaseBackupInspection {
  return {
    manifest: {
      manifestVersion: 2,
      kind: 'manual',
      createdAt: 1,
      appVersion: 'test',
      includesWorktrees: false,
      migration: { lastHash: null, lastCreatedAt: null },
      database: {
        format: 'agent-workflow-logical-database-v1',
        provider: 'postgresql',
        sourceGenerationId: 'dbg_postgresql_source_01',
        schemaDigest: `sha256:${'b'.repeat(64)}`,
        logicalPath: 'database/logical',
        envelopeFileDigest: `sha256:${'c'.repeat(64)}`,
        rawSqlitePath: null,
      },
    } satisfies BackupManifestV2,
    envelope: {
      payload: {
        version: 1,
        operationId: 'dbm_backup_source_01',
        sourceProvider: 'postgresql',
        sourceGenerationId: 'dbg_postgresql_source_01',
        schemaDigest: `sha256:${'b'.repeat(64)}`,
        logicalManifestDigest: `sha256:${'d'.repeat(64)}`,
        legacyArchiveFileDigest: `sha256:${'e'.repeat(64)}`,
        activeTableCount: 1,
        archiveOnlyTableCount: 0,
        activeRows: 1,
        archiveRows: 0,
        chunks: 1,
        bytes: 1,
        completedAt: 1,
      },
      digest: ENVELOPE_DIGEST,
    },
    verification: {} as PortableDatabaseBackupInspection['verification'],
  }
}

function fixture(overrides: Partial<CreatePostgresqlAdminRestoreCoordinatorInput> = {}) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc349-postgresql-restore-'))
  mkdirSync(appHome, { recursive: true })
  const tarballPath = join(appHome, 'restore.tar.gz')
  writeFileSync(tarballPath, 'fixture')
  const artifactRef = Object.freeze({}) as RestoreArtifactRef
  const preflightOperations: string[] = []
  const restoreOperations: string[] = []
  const coordinator = createPostgresqlAdminRestoreCoordinator({
    artifacts: { pathOf: () => tarballPath },
    runtime: { provider: 'postgresql', generationId: GENERATION } as PostgresqlDatabaseRuntime,
    targetGenerationId: GENERATION,
    appHome,
    lockPath: join(appHome, '.daemon.lock'),
    contract: { digest: `sha256:${'b'.repeat(64)}` } as LogicalSchemaContract,
    plan: { contractDigest: `sha256:${'b'.repeat(64)}` } as PostgresqlSchemaPlan,
    filesystem: { async apply() {} },
    inspectBackup: async () => inspection(),
    async preflightTarget({ operationId }) {
      preflightOperations.push(operationId)
      return {
        ok: true,
        databaseFingerprint: 'pg:test',
        serverMajor: 16,
        serverVersionNum: 160_000,
        serverEncoding: 'UTF8',
        timezone: 'UTC',
        databaseBytes: 0,
        targetState: preflightOperations.length === 1 ? 'empty' : 'resumable',
        applicationTableCount: 0,
        metadataTableCount: 0,
      }
    },
    async restoreBackup(options) {
      restoreOperations.push(options.restoreOperationId)
      return {
        manifest: inspection().manifest,
        envelope: inspection().envelope,
        receipt: {} as PortableDatabaseRestoreResult['receipt'],
        filesystem: { config: true, skills: false },
      }
    },
    readPid: () => null,
    lock: () => ({ pid: 1, path: join(appHome, '.daemon.lock'), release() {} }),
    ...overrides,
  })
  return { appHome, artifactRef, coordinator, preflightOperations, restoreOperations }
}

describe('RFC-349 PostgreSQL admin restore', () => {
  test('stages only an empty target and resumes the exact same logical operation on boot', async () => {
    const { coordinator, artifactRef, preflightOperations, restoreOperations } = fixture()

    expect(
      await coordinator.stage(artifactRef, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).toEqual({ direction: 'same' })
    expect(coordinator.status().pending).toMatchObject({ stagedBytes: 7 })

    expect(await coordinator.applyPending()).toBe(true)
    expect(preflightOperations).toEqual([RESTORE_OPERATION, RESTORE_OPERATION])
    expect(restoreOperations).toEqual([RESTORE_OPERATION])
    expect(coordinator.status().pending).toBeNull()
  })

  test('rejects a live non-empty target with stable operator guidance and stages nothing', async () => {
    const { coordinator, artifactRef } = fixture({
      async preflightTarget() {
        throw new PostgresqlPreflightError(
          'postgresql-target-not-empty',
          'live target is not empty',
        )
      },
    })

    let failure: unknown
    try {
      await coordinator.stage(artifactRef, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({ code: 'postgresql-restore-target-not-empty', status: 409 })
    expect((failure as Error).message).toContain('switch the profile to an empty target')
    expect(coordinator.status().pending).toBeNull()
  })

  test('cold activation reports the provider-neutral filesystem receipt', async () => {
    const { coordinator, artifactRef } = fixture()
    await expect(
      coordinator.activateLocal(artifactRef, {
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }),
    ).resolves.toEqual({
      status: 'completed',
      direction: 'same',
      safetyBackupPath: null,
      migrated: false,
      restored: { db: true, config: true, skills: false },
    })
  })
})
