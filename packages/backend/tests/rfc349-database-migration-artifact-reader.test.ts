// RFC-349 T8 — legacy inspection/export must be bounded to the approved six-
// table archive and re-verify every durable digest before returning bytes.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createDatabaseMigrationManifest } from '@/modules/system-operations/domain/databaseMigration'
import {
  createDatabaseMigrationArtifactReader,
  DatabaseMigrationArtifactError,
} from '@/modules/system-operations/infrastructure/databaseMigrationArtifactReader'
import {
  createLegacyArchiveManifest,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  encodeLogicalRow,
  logicalChunkPath,
  summarizeLogicalTableChunks,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
  type LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  canonicalSchemaJson,
  type LogicalColumnContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const OPERATION_ID = 'dbm_operation_0001'
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`
const VERIFICATION_DIGEST = `sha256:${'b'.repeat(64)}`

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
    ownerContext: 'development-automation',
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
    retention: {
      class: 'owner-managed-business',
      owner: 'development-automation',
      rule: 'fixture',
    },
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-artifact-reader-'))
  roots.push(root)
  const operationsRoot = join(root, 'database-migrations')
  const operationRoot = join(operationsRoot, OPERATION_ID)
  const archiveChunk: LogicalTableChunk = createLogicalTableChunk({
    operationId: OPERATION_ID,
    contract: CONTRACT,
    table: ARCHIVE,
    chunkIndex: 0,
    rows: [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'preserved' })],
  })
  const chunkPath = writeLogicalTableChunk(operationRoot, archiveChunk)
  const archiveEntry = summarizeLogicalTableChunks({ table: ARCHIVE, chunks: [archiveChunk] })
  const activeEntry = summarizeLogicalTableChunks({ table: ACTIVE, chunks: [] })
  const logical = createLogicalArtifactManifest({
    operationId: OPERATION_ID,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_legacy_sqlite',
    contract: CONTRACT,
    createdAt: 1,
    tables: [activeEntry, archiveEntry],
  })
  writeLogicalArtifactManifest(operationRoot, logical)
  const legacy = createLegacyArchiveManifest({
    operationId: OPERATION_ID,
    schemaDigest: CONTRACT.digest,
    tables: [archiveEntry],
  })
  const legacyDigest = writeDurableLogicalArtifact(
    join(operationRoot, 'legacy-archive', 'manifest.json'),
    legacy,
  )
  const receipt = {
    version: 1 as const,
    operationId: OPERATION_ID,
    sourceGenerationId: 'dbg_legacy_sqlite',
    targetGenerationId: 'dbg_pg_operation_0001',
    schemaDigest: CONTRACT.digest,
    logicalBackupDigest: logical.digest,
    legacyArchiveDigest: legacyDigest,
    verificationDigest: VERIFICATION_DIGEST,
    firstLiveWriteAt: null,
    finalizedAt: 2,
  }
  const receiptDigest = writeDurableLogicalArtifact(join(operationRoot, 'receipt.json'), receipt)
  const base = createDatabaseMigrationManifest({
    operationId: OPERATION_ID,
    idempotencyKey: 'artifact-reader-fixture',
    sourceGenerationId: 'dbg_legacy_sqlite',
    sourceSchemaDigest: CONTRACT.digest,
    sourceDatabaseFingerprint: 'sqlite:fixture',
    target: {
      provider: 'postgresql',
      urlEnv: 'AW_DATABASE_URL',
      poolMax: 4,
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 60_000,
      idleTimeoutMs: 30_000,
    },
    ownerId: 'dbo_owner_0001',
    ownerLeaseExpiresAt: 60_000,
    tableCounts: { source: 2, active: 1, archiveOnly: 1 },
    now: 1,
  })
  const manifest = {
    ...base,
    payload: {
      ...base.payload,
      logicalBackupDigest: logical.digest,
      legacyArchiveDigest: legacyDigest,
      verificationDigest: VERIFICATION_DIGEST,
      receiptDigest,
    },
  }
  const controlPlane = {
    readManifest(operationId: string) {
      if (operationId !== OPERATION_ID) throw new Error('not found')
      return manifest
    },
  } as DatabaseMigrationControlPlane
  const reader = createDatabaseMigrationArtifactReader({
    operationsRoot,
    controlPlane,
    contract: CONTRACT,
  })
  return { reader, chunkPath, operationRoot, logical, legacyDigest, receiptDigest }
}

describe('RFC-349 database migration artifact reader', () => {
  test('re-verifies and projects receipt, legacy summary and one bounded chunk', () => {
    const { reader, receiptDigest } = fixture()
    expect(reader.readArtifact({ operationId: OPERATION_ID, kind: 'receipt' })).toMatchObject({
      operationId: OPERATION_ID,
      kind: 'receipt',
      digest: receiptDigest,
      fileDigest: receiptDigest,
    })
    expect(
      reader.inspectLegacyTable({ operationId: OPERATION_ID, table: ARCHIVE.id }),
    ).toMatchObject({
      table: ARCHIVE.id,
      disposition: 'ARCHIVE_THEN_OMIT',
      rowCount: 1,
      chunkCount: 1,
      firstKey: ['{"type":"text","value":"legacy-1"}'],
    })
    const chunk = reader.readLegacyChunk({
      operationId: OPERATION_ID,
      table: ARCHIVE.id,
      chunkIndex: 0,
    })
    expect(chunk).toMatchObject({
      kind: 'legacy-archive-chunk',
      digest: expect.stringMatching(/^sha256:/),
      fileDigest: expect.stringMatching(/^sha256:/),
    })
    expect(JSON.parse(chunk.json).payload.rows).toHaveLength(1)
  })

  test('rejects a mutated chunk even when its path and control manifest still exist', () => {
    const { reader, chunkPath } = fixture()
    const value = JSON.parse(readFileSync(chunkPath, 'utf8'))
    value.payload.rows[0].values[1].value = 'tampered'
    writeFileSync(chunkPath, canonicalSchemaJson(value))
    expect(() =>
      reader.readLegacyChunk({
        operationId: OPERATION_ID,
        table: ARCHIVE.id,
        chunkIndex: 0,
      }),
    ).toThrow(DatabaseMigrationArtifactError)
  })

  test('rejects non-archive tables, missing chunks and a mismatched legacy control digest', () => {
    const { reader, operationRoot } = fixture()
    expect(() =>
      reader.inspectLegacyTable({ operationId: OPERATION_ID, table: ACTIVE.id }),
    ).toThrow('not present in the approved legacy archive')
    expect(() =>
      reader.readLegacyChunk({
        operationId: OPERATION_ID,
        table: ARCHIVE.id,
        chunkIndex: 1,
      }),
    ).toThrow('does not exist')

    const legacyPath = join(operationRoot, 'legacy-archive', 'manifest.json')
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'))
    legacy.tables[0].rowCount = 99
    writeFileSync(legacyPath, canonicalSchemaJson(legacy))
    expect(() =>
      reader.inspectLegacyTable({ operationId: OPERATION_ID, table: ARCHIVE.id }),
    ).toThrow('legacy archive file digest')
  })

  test('derives the chunk path from validated contract data only', () => {
    const { chunkPath, operationRoot } = fixture()
    expect(chunkPath).toBe(logicalChunkPath(operationRoot, ARCHIVE, 0))
  })
})
