// RFC-349 T6 — both providers produce one logical backup format. PostgreSQL
// reads active tables from its snapshot and carries the independently verified
// legacy archive forward instead of recreating six active tables.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLegacyArchiveManifest,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  encodeLogicalRow,
  logicalChunkPath,
  readLogicalTableChunk,
  summarizeLogicalTableChunks,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  exportLogicalDatabaseArtifact,
  readLogicalDatabaseBackupEnvelope,
  LogicalDatabaseExportError,
  type LogicalDatabaseExportSource,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  verifyLogicalDatabaseArtifactTree,
} from '@/platform/persistence/logicalDatabaseRestore'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const SCHEMA_DIGEST = `sha256:${'e'.repeat(64)}`

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

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

function preservedArchive() {
  const artifactRoot = root('rfc349-preserved-archive-')
  const operationId = 'dbm_preserved_archive_01'
  const archiveChunk = createLogicalTableChunk({
    operationId,
    contract: CONTRACT,
    table: ARCHIVE,
    chunkIndex: 0,
    rows: [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'preserved' })],
  })
  writeLogicalTableChunk(artifactRoot, archiveChunk)
  const activeEntry = summarizeLogicalTableChunks({ table: ACTIVE, chunks: [] })
  const archiveEntry = summarizeLogicalTableChunks({ table: ARCHIVE, chunks: [archiveChunk] })
  const manifest = createLogicalArtifactManifest({
    operationId,
    sourceProvider: 'sqlite',
    sourceGenerationId: 'dbg_original_sqlite_01',
    contract: CONTRACT,
    createdAt: 1,
    tables: [activeEntry, archiveEntry],
  })
  writeLogicalArtifactManifest(artifactRoot, manifest)
  const legacyArchiveFileDigest = writeDurableLogicalArtifact(
    join(artifactRoot, 'legacy-archive', 'manifest.json'),
    createLegacyArchiveManifest({
      operationId,
      schemaDigest: CONTRACT.digest,
      tables: [archiveEntry],
    }),
  )
  return openVerifiedLogicalDatabaseArtifactSource({
    artifactRoot,
    expectedManifestDigest: manifest.digest,
    expectedLegacyArchiveFileDigest: legacyArchiveFileDigest,
    contract: CONTRACT,
  })
}

function source(provider: 'sqlite' | 'postgresql'): {
  readonly value: LogicalDatabaseExportSource
  readonly tablesRead: string[]
} {
  const rows = new Map([
    [
      ACTIVE.id,
      [
        encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'one' }),
        encodeLogicalRow(ACTIVE, { id: 'active-2', value: 'two' }),
      ],
    ],
    [ARCHIVE.id, [encodeLogicalRow(ARCHIVE, { id: 'legacy-2', value: 'sqlite-only' })]],
  ])
  const tablesRead: string[] = []
  return {
    tablesRead,
    value: {
      provider,
      async assertUnchanged() {},
      async readChunk(table, afterKey, limit) {
        tablesRead.push(table.id)
        const tableRows = rows.get(table.id) ?? []
        const start =
          afterKey === null
            ? 0
            : tableRows.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(afterKey)) + 1
        return tableRows.slice(start, start + limit)
      },
    },
  }
}

describe('RFC-349 logical database export', () => {
  test('exports PostgreSQL active rows and re-binds the verified legacy archive', async () => {
    const live = source('postgresql')
    const output = root('rfc349-postgresql-backup-')
    const operationId = 'dbm_postgresql_backup_01'
    const receipt = await exportLogicalDatabaseArtifact({
      operationId,
      sourceProvider: 'postgresql',
      sourceGenerationId: 'dbg_postgresql_live_01',
      source: live.value,
      expectedTableRows: { [ACTIVE.id]: 2 },
      contract: CONTRACT,
      artifactRoot: output,
      preservedArchive: preservedArchive(),
      chunkRows: 1,
      now: () => 9,
    })
    expect(receipt).toMatchObject({ activeRows: 2, archiveRows: 1, chunks: 3 })
    expect(
      readLogicalDatabaseBackupEnvelope({
        artifactRoot: output,
        expectedFileDigest: receipt.envelopeFileDigest,
      }),
    ).toEqual(receipt.envelope)
    expect(receipt.envelope.payload).toMatchObject({
      sourceProvider: 'postgresql',
      sourceGenerationId: 'dbg_postgresql_live_01',
      logicalManifestDigest: receipt.manifest.digest,
      legacyArchiveFileDigest: receipt.legacyArchiveFileDigest,
      activeRows: 2,
      archiveRows: 1,
      chunks: 3,
    })
    expect(live.tablesRead).not.toContain(ARCHIVE.id)
    expect(readLogicalTableChunk(logicalChunkPath(output, ARCHIVE, 0)).payload.operationId).toBe(
      operationId,
    )
    expect(
      verifyLogicalDatabaseArtifactTree({
        artifactRoot: output,
        expectedManifestDigest: receipt.manifest.digest,
        expectedLegacyArchiveFileDigest: receipt.legacyArchiveFileDigest,
        contract: CONTRACT,
      }),
    ).toMatchObject({ activeRows: 2, archiveRows: 1, activeChunks: 2, archiveChunks: 1 })
  })

  test('exports SQLite archive rows directly and rejects PostgreSQL without preserved history', async () => {
    const sqlite = source('sqlite')
    const output = root('rfc349-sqlite-backup-')
    const receipt = await exportLogicalDatabaseArtifact({
      operationId: 'dbm_sqlite_backup_01',
      sourceProvider: 'sqlite',
      sourceGenerationId: 'dbg_sqlite_live_01',
      source: sqlite.value,
      expectedTableRows: { [ACTIVE.id]: 2, [ARCHIVE.id]: 1 },
      contract: CONTRACT,
      artifactRoot: output,
      chunkRows: 2,
      now: () => 10,
    })
    expect(receipt).toMatchObject({ activeRows: 2, archiveRows: 1, chunks: 2 })
    expect(sqlite.tablesRead).toContain(ARCHIVE.id)

    const postgresql = source('postgresql')
    await expect(
      exportLogicalDatabaseArtifact({
        operationId: 'dbm_postgresql_backup_02',
        sourceProvider: 'postgresql',
        sourceGenerationId: 'dbg_postgresql_live_02',
        source: postgresql.value,
        expectedTableRows: { [ACTIVE.id]: 2 },
        contract: CONTRACT,
        artifactRoot: root('rfc349-missing-archive-'),
      }),
    ).rejects.toBeInstanceOf(LogicalDatabaseExportError)
    expect(postgresql.tablesRead).toHaveLength(0)
  })

  test('rejects a provider source that returns migration keys out of stable order', async () => {
    const ordered = source('sqlite')
    const originalRead = ordered.value.readChunk.bind(ordered.value)
    const sourceWithBadOrder: LogicalDatabaseExportSource = {
      ...ordered.value,
      async readChunk(table, afterKey, limit) {
        const rows = await originalRead(table, afterKey, limit)
        return table.id === ACTIVE.id && afterKey === null ? [...rows].reverse() : rows
      },
    }
    await expect(
      exportLogicalDatabaseArtifact({
        operationId: 'dbm_bad_order_backup_01',
        sourceProvider: 'sqlite',
        sourceGenerationId: 'dbg_sqlite_bad_order_01',
        source: sourceWithBadOrder,
        expectedTableRows: { [ACTIVE.id]: 2, [ARCHIVE.id]: 1 },
        contract: CONTRACT,
        artifactRoot: root('rfc349-bad-order-'),
        chunkRows: 2,
      }),
    ).rejects.toMatchObject({ code: 'logical-export-source-order' })
  })
})
