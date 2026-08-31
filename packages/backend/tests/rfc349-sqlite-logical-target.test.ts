// RFC-349 T6 — the SQLite logical target keeps archive-only history empty,
// persists idempotent chunk receipts, and verifies the restored database before
// it can become a live generation.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { restoreLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseRestore'
import {
  createSqliteLogicalTarget,
  SqliteLogicalTargetError,
} from '@/platform/persistence/sqliteLogicalTarget'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const roots: string[] = []
const SOURCE_OPERATION_ID = 'dbm_sqlite_source_01'
const RESTORE_OPERATION_ID = 'dbm_sqlite_restore_01'
const SCHEMA_DIGEST = `sha256:${'c'.repeat(64)}`

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

function temporaryRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-sqlite-target-'))
  roots.push(root)
  const artifactRoot = join(root, 'artifact')
  const chunks = [
    createLogicalTableChunk({
      operationId: SOURCE_OPERATION_ID,
      contract: CONTRACT,
      table: ACTIVE,
      chunkIndex: 0,
      rows: [
        encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'one' }),
        encodeLogicalRow(ACTIVE, { id: 'active-2', value: 'two' }),
      ],
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
  for (const chunk of [...chunks, ...archiveChunks]) writeLogicalTableChunk(artifactRoot, chunk)
  const activeEntry = summarizeLogicalTableChunks({ table: ACTIVE, chunks })
  const archiveEntry = summarizeLogicalTableChunks({ table: ARCHIVE, chunks: archiveChunks })
  const manifest = createLogicalArtifactManifest({
    operationId: SOURCE_OPERATION_ID,
    sourceProvider: 'postgresql',
    sourceGenerationId: 'dbg_postgresql_source_01',
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
  const database = new Database(':memory:')
  database.exec(
    'CREATE TABLE active_rows (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); CREATE TABLE code_artifacts (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);',
  )
  const target = createSqliteLogicalTarget({
    database,
    operationId: RESTORE_OPERATION_ID,
    contract: CONTRACT,
    checkpointRoot: join(root, 'checkpoint'),
  })
  return { artifactRoot, manifest, legacyArchiveFileDigest, database, target }
}

describe('RFC-349 SQLite logical target', () => {
  test('restores active rows, preserves archive-only rows externally and resumes idempotently', async () => {
    const value = fixture()
    const run = () =>
      restoreLogicalDatabaseArtifact({
        artifactRoot: value.artifactRoot,
        expectedManifestDigest: value.manifest.digest,
        expectedLegacyArchiveFileDigest: value.legacyArchiveFileDigest,
        restoreOperationId: RESTORE_OPERATION_ID,
        contract: CONTRACT,
        target: value.target,
        now: () => 5,
      })
    expect((await run()).rowsRestored).toBe(2)
    expect(
      (
        await restoreLogicalDatabaseArtifact({
          artifactRoot: value.artifactRoot,
          expectedManifestDigest: value.manifest.digest,
          expectedLegacyArchiveFileDigest: value.legacyArchiveFileDigest,
          restoreOperationId: RESTORE_OPERATION_ID,
          contract: CONTRACT,
          target: value.target,
          now: () => 9,
        })
      ).rowsRestored,
    ).toBe(2)
    expect(value.database.query('SELECT id, value FROM active_rows ORDER BY id').all()).toEqual([
      { id: 'active-1', value: 'one' },
      { id: 'active-2', value: 'two' },
    ])
    expect(value.database.query('SELECT count(*) AS count FROM code_artifacts').get()).toEqual({
      count: 0,
    })
    await value.target.close()
    value.database.close()
  })

  test('rejects a non-empty target before creating a restore identity', async () => {
    const value = fixture()
    value.database.exec("INSERT INTO active_rows (id, value) VALUES ('foreign', 'row')")
    await expect(
      restoreLogicalDatabaseArtifact({
        artifactRoot: value.artifactRoot,
        expectedManifestDigest: value.manifest.digest,
        expectedLegacyArchiveFileDigest: value.legacyArchiveFileDigest,
        restoreOperationId: RESTORE_OPERATION_ID,
        contract: CONTRACT,
        target: value.target,
      }),
    ).rejects.toBeInstanceOf(SqliteLogicalTargetError)
    expect(value.database.query('SELECT count(*) AS count FROM active_rows').get()).toEqual({
      count: 1,
    })
    await value.target.close()
    value.database.close()
  })

  test('clears migration seed rows only when the caller marks a new migrated generation', async () => {
    const value = fixture()
    value.database.exec("INSERT INTO active_rows (id, value) VALUES ('seed', 'migration')")
    const target = createSqliteLogicalTarget({
      database: value.database,
      operationId: 'dbm_sqlite_fresh_restore_01',
      contract: CONTRACT,
      checkpointRoot: join(temporaryRoot('rfc349-sqlite-fresh-'), 'checkpoint'),
      initialState: 'fresh-migrated',
    })
    const receipt = await restoreLogicalDatabaseArtifact({
      artifactRoot: value.artifactRoot,
      expectedManifestDigest: value.manifest.digest,
      expectedLegacyArchiveFileDigest: value.legacyArchiveFileDigest,
      restoreOperationId: 'dbm_sqlite_fresh_restore_01',
      contract: CONTRACT,
      target,
      now: () => 11,
    })
    expect(receipt.rowsRestored).toBe(2)
    expect(value.database.query('SELECT id FROM active_rows ORDER BY id').all()).toEqual([
      { id: 'active-1' },
      { id: 'active-2' },
    ])
    await target.close()
    await value.target.close()
    value.database.close()
  })
})
