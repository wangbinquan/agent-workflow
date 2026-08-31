// RFC-349 T6 — the normal Settings/CLI backup is a provider-neutral archive:
// PostgreSQL contributes logical rows, carries the cutover's legacy archive,
// and never fabricates a db.sqlite or depends on pg_dump.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
  serializeDatabaseMigrationManifest,
  type DatabaseMigrationManifest,
  type DatabaseMigrationPhase,
} from '@/modules/system-operations/domain/databaseMigration'
import { createPostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import type { PostgresqlProviderBackupError } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import {
  createLegacyArchiveManifest,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  encodeLogicalRow,
  summarizeLogicalTableChunks,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  digestDatabaseArtifact,
  writeDatabaseGenerationAtomic,
} from '@/platform/persistence/generationStore'
import { readLogicalDatabaseBackupEnvelope } from '@/platform/persistence/logicalDatabaseExport'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import { readManifest } from '@/services/backupManifest'
import { extractTarGz } from '@/util/archive'

const roots: string[] = []
const OPERATION_ID = 'dbm_operation_0001'
const GENERATION_ID = 'dbg_pg_operation_0001'
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`
const FILE_DIGEST = `sha256:${'b'.repeat(64)}`

function column(name: string): LogicalColumnContract {
  return {
    name,
    logicalCodec: 'text-identity',
    nullable: false,
    primary: name === 'id',
    hasDefault: false,
    defaultKind: 'none',
    defaultValue: null,
    providerDefault: { sqlite: null, postgresql: null },
    identity: false,
    uniqueName: null,
    enumValues: [],
    providerType: { sqlite: 'text', postgresql: 'text' },
  }
}

function table(id: string, disposition: LogicalTableContract['disposition']): LogicalTableContract {
  return {
    id,
    schemaSymbol: id,
    ownerContext: 'system-operations',
    disposition,
    sourceTable: id,
    providerTables:
      disposition === 'ARCHIVE_THEN_OMIT' ? { sqlite: id } : { sqlite: id, postgresql: id },
    migrationKey: ['id'],
    columns: [column('id'), column('value')],
    primaryKey: ['id'],
    unique: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    retention: { class: 'owner-managed-business', owner: 'system-operations', rule: 'fixture' },
    consumers: {
      productionReader: 'owner-required',
      productionWriter: 'owner-required-or-immutable',
      backgroundRecoveryDiagnostic: 'owner-reviewed',
      evidence: 'fixture',
    },
    rationale: 'fixture',
  }
}

const ACTIVE = table('active_rows', 'KEEP')
const ARCHIVE = table('code_artifacts', 'ARCHIVE_THEN_OMIT')
const CONTRACT: LogicalSchemaContract = {
  contractVersion: 2,
  sourceProjection: 'sqlite',
  sourceTableCount: 2,
  activeTableCount: 1,
  archiveOnlyTableCount: 1,
  tables: [ACTIVE, ARCHIVE],
  digest: SCHEMA_DIGEST,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'rfc349-postgresql-backup-'))
  roots.push(value)
  return value
}

function advanceToAcceptingWrites(input: {
  readonly logicalDigest: string
  readonly archiveDigest: string
}): DatabaseMigrationManifest {
  let current = createDatabaseMigrationManifest({
    operationId: OPERATION_ID,
    idempotencyKey: 'request-0001',
    sourceGenerationId: 'dbg_legacy_sqlite',
    sourceSchemaDigest: CONTRACT.digest,
    sourceDatabaseFingerprint: 'sqlite:fixture',
    target: {
      provider: 'postgresql',
      urlEnv: 'RFC349_TEST_DATABASE_URL',
      poolMax: 8,
      connectTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    },
    ownerId: 'dbo_owner_0001',
    ownerLeaseExpiresAt: 60_000,
    tableCounts: { source: 2, active: 1, archiveOnly: 1 },
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
  for (const nextPhase of phases) {
    const expectedPhase = current.payload.phase
    current = advanceDatabaseMigration(current, {
      expectedRevision: current.payload.revision,
      expectedPhase,
      nextPhase,
      ownerId: current.payload.owner.id,
      ownerFence: current.payload.owner.fence,
      idempotencyKey: `step-${nextPhase}`,
      now: current.payload.updatedAt + 1,
      ...(nextPhase === 'preflighted' ? { targetDatabaseFingerprint: 'pg:fixture' } : {}),
      ...(nextPhase === 'backed-up' ? { sourceBackupDigest: FILE_DIGEST } : {}),
      ...(nextPhase === 'verifying'
        ? {
            logicalBackupDigest: input.logicalDigest,
            legacyArchiveDigest: input.archiveDigest,
          }
        : {}),
      ...(nextPhase === 'cutover-prepared' ? { verificationDigest: FILE_DIGEST } : {}),
    })
  }
  return current
}

function livePostgresqlFixture() {
  const appHome = tempRoot()
  const operationsRoot = join(appHome, 'database-migrations')
  const operationRoot = join(operationsRoot, OPERATION_ID)
  const archiveChunk = createLogicalTableChunk({
    operationId: OPERATION_ID,
    contract: CONTRACT,
    table: ARCHIVE,
    chunkIndex: 0,
    rows: [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'preserved' })],
  })
  writeLogicalTableChunk(operationRoot, archiveChunk)
  const activeEntry = summarizeLogicalTableChunks({ table: ACTIVE, chunks: [] })
  const archiveEntry = summarizeLogicalTableChunks({ table: ARCHIVE, chunks: [archiveChunk] })
  const logical = createLogicalArtifactManifest({
    operationId: OPERATION_ID,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_legacy_sqlite',
    contract: CONTRACT,
    createdAt: 1,
    tables: [activeEntry, archiveEntry],
  })
  writeLogicalArtifactManifest(operationRoot, logical)
  const archiveDigest = writeDurableLogicalArtifact(
    join(operationRoot, 'legacy-archive', 'manifest.json'),
    createLegacyArchiveManifest({
      operationId: OPERATION_ID,
      schemaDigest: CONTRACT.digest,
      tables: [archiveEntry],
    }),
  )
  const migration = advanceToAcceptingWrites({
    logicalDigest: logical.digest,
    archiveDigest,
  })
  const serializedMigration = serializeDatabaseMigrationManifest(migration)
  writeFileSync(join(operationRoot, 'manifest.json'), serializedMigration)
  writeDatabaseGenerationAtomic({
    pointerPath: join(appHome, 'database-generation.json'),
    payload: {
      version: 1,
      generationId: GENERATION_ID,
      provider: 'postgresql',
      operationId: OPERATION_ID,
      schemaDigest: CONTRACT.digest,
      manifestDigest: digestDatabaseArtifact(serializedMigration),
      activatedAt: 11,
    },
  })
  const runtime = {
    provider: 'postgresql',
    generationId: GENERATION_ID,
  } as PostgresqlDatabaseRuntime
  return { appHome, operationsRoot, runtime }
}

function logicalSource(onClose: () => void): PostgresqlLogicalSource {
  const rows = [encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'live' })]
  const snapshot = Object.freeze({
    databaseFingerprint: 'pg:fixture',
    generationId: GENERATION_ID,
    schemaDigest: CONTRACT.digest,
    totalRows: 1,
    tableRows: Object.freeze({ [ACTIVE.id]: 1 }),
  })
  return {
    provider: 'postgresql',
    generationId: GENERATION_ID,
    async preflight() {
      return snapshot
    },
    async assertUnchanged(expected) {
      expect(expected).toBe(snapshot)
    },
    async readChunk(table, afterKey) {
      expect(table.id).toBe(ACTIVE.id)
      return afterKey === null ? rows : []
    },
    async close() {
      onClose()
    },
  }
}

describe('RFC-349 PostgreSQL provider backup', () => {
  test('packages live PostgreSQL rows and preserved legacy rows without db.sqlite', async () => {
    const fixture = livePostgresqlFixture()
    writeFileSync(join(fixture.appHome, 'config.json'), '{"database":{"provider":"postgresql"}}')
    mkdirSync(join(fixture.appHome, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(fixture.appHome, 'skills', 'demo', 'SKILL.md'), 'demo')
    let closed = 0

    const backup = await createPostgresqlProviderBackup({
      ...fixture,
      contract: CONTRACT,
      now: 5,
      includeWorktrees: true,
      application: {
        async exportWorkflows(destination) {
          writeFileSync(join(destination, 'workflow.yaml'), 'name: workflow')
          return 1
        },
        async captureWorktrees(stagingDirectory) {
          mkdirSync(join(stagingDirectory, 'worktrees', 'task-1'), { recursive: true })
          writeFileSync(join(stagingDirectory, 'worktrees', 'task-1', 'patch'), 'diff')
        },
      },
      openLogicalSource: async () => logicalSource(() => (closed += 1)),
    })

    const extracted = tempRoot()
    await extractTarGz(backup.path, extracted)
    expect(backup.contents).toEqual({ workflows: 1, skills: 1, config: true, db: true })
    expect(closed).toBe(1)
    expect(existsSync(join(extracted, 'db.sqlite'))).toBe(false)
    expect(existsSync(join(extracted, 'worktrees', 'task-1', 'patch'))).toBe(true)
    const manifest = readManifest(extracted)
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      includesWorktrees: true,
      migration: { lastHash: null, lastCreatedAt: null },
      database: {
        provider: 'postgresql',
        sourceGenerationId: GENERATION_ID,
        schemaDigest: CONTRACT.digest,
        rawSqlitePath: null,
      },
    })
    if (manifest?.manifestVersion !== 2) throw new Error('expected backup manifest v2')
    const envelope = readLogicalDatabaseBackupEnvelope({
      artifactRoot: join(extracted, manifest.database.logicalPath),
      expectedFileDigest: manifest.database.envelopeFileDigest,
    })
    expect(envelope.payload).toMatchObject({
      sourceProvider: 'postgresql',
      sourceGenerationId: GENERATION_ID,
      activeRows: 1,
      archiveRows: 1,
      activeTableCount: 1,
      archiveOnlyTableCount: 1,
    })
  })

  test('refuses a PostgreSQL adapter when the durable live pointer is SQLite', async () => {
    const appHome = tempRoot()
    let opened = false
    const runtime = {
      provider: 'postgresql',
      generationId: GENERATION_ID,
    } as PostgresqlDatabaseRuntime
    await expect(
      createPostgresqlProviderBackup({
        appHome,
        runtime,
        contract: CONTRACT,
        application: {
          async exportWorkflows() {
            return 0
          },
          async captureWorktrees() {},
        },
        openLogicalSource: async () => {
          opened = true
          return logicalSource(() => undefined)
        },
      }),
    ).rejects.toMatchObject({
      name: 'PostgresqlProviderBackupError',
      code: 'postgresql-backup-generation',
    } satisfies Partial<PostgresqlProviderBackupError>)
    expect(opened).toBe(false)
  })
})
