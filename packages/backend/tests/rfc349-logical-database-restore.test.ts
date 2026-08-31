// RFC-349 T6 — portable restore must verify the entire active + archive-only
// artifact before target prepare, replay only active tables, and re-key chunk
// receipts to the restore operation so crash/resume remains idempotent.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  LogicalDatabaseRestoreError,
  restoreLogicalDatabaseBackup,
  restoreLogicalDatabaseArtifact,
  verifyLogicalDatabaseArtifactTree,
  type LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import {
  exportLogicalDatabaseArtifact,
  type LogicalDatabaseExportSource,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  canonicalSchemaJson,
  type LogicalColumnContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const SOURCE_OPERATION_ID = 'dbm_source_artifact_01'
const RESTORE_OPERATION_ID = 'dbm_restore_target_01'
const SCHEMA_DIGEST = `sha256:${'a'.repeat(64)}`

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

function artifactFixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'rfc349-logical-restore-'))
  roots.push(artifactRoot)
  const activeChunks = [
    createLogicalTableChunk({
      operationId: SOURCE_OPERATION_ID,
      contract: CONTRACT,
      table: ACTIVE,
      chunkIndex: 0,
      rows: [encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'one' })],
    }),
    createLogicalTableChunk({
      operationId: SOURCE_OPERATION_ID,
      contract: CONTRACT,
      table: ACTIVE,
      chunkIndex: 1,
      rows: [encodeLogicalRow(ACTIVE, { id: 'active-2', value: 'two' })],
    }),
  ]
  const archiveChunks = [
    createLogicalTableChunk({
      operationId: SOURCE_OPERATION_ID,
      contract: CONTRACT,
      table: ARCHIVE,
      chunkIndex: 0,
      rows: [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'preserved' })],
    }),
  ]
  for (const chunk of [...activeChunks, ...archiveChunks]) {
    writeLogicalTableChunk(artifactRoot, chunk)
  }
  const activeEntry = summarizeLogicalTableChunks({ table: ACTIVE, chunks: activeChunks })
  const archiveEntry = summarizeLogicalTableChunks({ table: ARCHIVE, chunks: archiveChunks })
  const manifest = createLogicalArtifactManifest({
    operationId: SOURCE_OPERATION_ID,
    sourceProvider: 'postgresql',
    sourceGenerationId: 'dbg_source_generation_01',
    contract: CONTRACT,
    createdAt: 1,
    tables: [activeEntry, archiveEntry],
  })
  writeLogicalArtifactManifest(artifactRoot, manifest)
  const legacyArchiveFileDigest = writeDurableLogicalArtifact(
    join(artifactRoot, 'legacy-archive', 'manifest.json'),
    createLegacyArchiveManifest({
      operationId: SOURCE_OPERATION_ID,
      schemaDigest: CONTRACT.digest,
      tables: [archiveEntry],
    }),
  )
  return { artifactRoot, manifest, legacyArchiveFileDigest }
}

function target(operationId = RESTORE_OPERATION_ID) {
  const calls = { prepare: 0, finalize: 0, chunks: [] as LogicalTableChunk[] }
  const restoreTarget: LogicalDatabaseRestoreTarget = {
    provider: 'postgresql',
    operationId,
    async prepare() {
      calls.prepare += 1
    },
    async copyChunk(_table, chunk) {
      calls.chunks.push(chunk)
    },
    async finalizeSchema() {
      calls.finalize += 1
    },
  }
  return { restoreTarget, calls }
}

describe('RFC-349 logical database restore', () => {
  test('verifies both artifact areas and restores only active tables under a new operation', async () => {
    const fixture = artifactFixture()
    const { restoreTarget, calls } = target()
    const progress: number[] = []
    const receipt = await restoreLogicalDatabaseArtifact({
      ...fixture,
      expectedManifestDigest: fixture.manifest.digest,
      expectedLegacyArchiveFileDigest: fixture.legacyArchiveFileDigest,
      restoreOperationId: RESTORE_OPERATION_ID,
      contract: CONTRACT,
      target: restoreTarget,
      now: () => 7,
      onProgress: (event) => progress.push(event.chunksRestored),
    })
    expect(calls).toMatchObject({ prepare: 1, finalize: 1 })
    expect(calls.chunks).toHaveLength(2)
    expect(calls.chunks.map((chunk) => chunk.payload.operationId)).toEqual([
      RESTORE_OPERATION_ID,
      RESTORE_OPERATION_ID,
    ])
    expect(calls.chunks.map((chunk) => chunk.payload.table)).toEqual([ACTIVE.id, ACTIVE.id])
    expect(progress).toEqual([1, 2])
    expect(receipt).toEqual({
      version: 1,
      operationId: RESTORE_OPERATION_ID,
      sourceOperationId: SOURCE_OPERATION_ID,
      sourceProvider: 'postgresql',
      sourceGenerationId: 'dbg_source_generation_01',
      targetProvider: 'postgresql',
      schemaDigest: CONTRACT.digest,
      logicalManifestDigest: fixture.manifest.digest,
      legacyArchiveFileDigest: fixture.legacyArchiveFileDigest,
      activeTablesRestored: 1,
      archiveTablesPreserved: 1,
      rowsRestored: 2,
      archiveRowsPreserved: 1,
      chunksRestored: 2,
      completedAt: 7,
    })
  })

  test('restores from one trusted backup-envelope digest without caller-supplied inner digests', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'rfc349-logical-backup-restore-'))
    roots.push(artifactRoot)
    const rows = new Map([
      [ACTIVE.id, [encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'one' })]],
      [ARCHIVE.id, [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'preserved' })]],
    ])
    const source: LogicalDatabaseExportSource = {
      provider: 'sqlite',
      async assertUnchanged() {},
      async readChunk(table, afterKey) {
        return afterKey === null ? (rows.get(table.id) ?? []) : []
      },
    }
    const exported = await exportLogicalDatabaseArtifact({
      operationId: SOURCE_OPERATION_ID,
      sourceProvider: 'sqlite',
      sourceGenerationId: 'dbg_source_generation_01',
      source,
      expectedTableRows: { [ACTIVE.id]: 1, [ARCHIVE.id]: 1 },
      contract: CONTRACT,
      artifactRoot,
      now: () => 5,
    })
    const { restoreTarget, calls } = target()

    const receipt = await restoreLogicalDatabaseBackup({
      artifactRoot,
      expectedEnvelopeFileDigest: exported.envelopeFileDigest,
      restoreOperationId: RESTORE_OPERATION_ID,
      contract: CONTRACT,
      target: restoreTarget,
      now: () => 6,
    })
    expect(receipt).toMatchObject({
      sourceProvider: 'sqlite',
      rowsRestored: 1,
      archiveRowsPreserved: 1,
    })
    expect(calls.prepare).toBe(1)
    expect(calls.chunks).toHaveLength(1)

    await expect(
      restoreLogicalDatabaseBackup({
        artifactRoot,
        expectedEnvelopeFileDigest: `sha256:${'f'.repeat(64)}`,
        restoreOperationId: RESTORE_OPERATION_ID,
        contract: CONTRACT,
        target: target().restoreTarget,
      }),
    ).rejects.toMatchObject({ code: 'logical-restore-artifact-corrupt' })
  })

  test('rejects a corrupt archive chunk before target prepare', async () => {
    const fixture = artifactFixture()
    const archivePath = logicalChunkPath(fixture.artifactRoot, ARCHIVE, 0)
    const chunk = JSON.parse(readFileSync(archivePath, 'utf8'))
    chunk.payload.rows[0].values[1].value = 'tampered'
    writeFileSync(archivePath, canonicalSchemaJson(chunk))
    const { restoreTarget, calls } = target()
    await expect(
      restoreLogicalDatabaseArtifact({
        ...fixture,
        expectedManifestDigest: fixture.manifest.digest,
        expectedLegacyArchiveFileDigest: fixture.legacyArchiveFileDigest,
        restoreOperationId: RESTORE_OPERATION_ID,
        contract: CONTRACT,
        target: restoreTarget,
      }),
    ).rejects.toBeInstanceOf(LogicalDatabaseRestoreError)
    expect(calls.prepare).toBe(0)
    expect(calls.chunks).toHaveLength(0)
  })

  test('rejects a mismatched trusted digest and target operation before writes', async () => {
    const fixture = artifactFixture()
    expect(() =>
      verifyLogicalDatabaseArtifactTree({
        artifactRoot: fixture.artifactRoot,
        expectedManifestDigest: `sha256:${'b'.repeat(64)}`,
        expectedLegacyArchiveFileDigest: fixture.legacyArchiveFileDigest,
        contract: CONTRACT,
      }),
    ).toThrow('trusted envelope')

    const { restoreTarget, calls } = target('dbm_another_target_01')
    await expect(
      restoreLogicalDatabaseArtifact({
        ...fixture,
        expectedManifestDigest: fixture.manifest.digest,
        expectedLegacyArchiveFileDigest: fixture.legacyArchiveFileDigest,
        restoreOperationId: RESTORE_OPERATION_ID,
        contract: CONTRACT,
        target: restoreTarget,
      }),
    ).rejects.toMatchObject({ code: 'logical-restore-target-operation-mismatch' })
    expect(calls.prepare).toBe(0)
  })
})
