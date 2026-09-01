// RFC-349 T6 — V2 logical backups restore across providers only after the
// outer manifest, trusted envelope, table chunks, archive and schema all agree.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restorePortableDatabaseBackup } from '@/modules/system-operations/infrastructure/portableDatabaseRestore'
import type { PortableDatabaseRestoreError } from '@/modules/system-operations/infrastructure/portableDatabaseRestore'
import { restorePostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderRestore'
import {
  createLegacyArchiveManifest,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  encodeLogicalRow,
  summarizeLogicalTableChunks,
  writeDurableLogicalArtifact,
  writeLogicalArtifactManifest,
  writeLogicalTableChunk,
  type CanonicalLogicalRow,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  type LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { PostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import type {
  LogicalColumnContract,
  LogicalSchemaContract,
  LogicalTableContract,
} from '@/platform/persistence/schemaContract'
import { writeManifest } from '@/services/backupManifest'
import { createPortableBackupArchive } from '@/services/portableBackupArchive'
import { extractTarGz, tarGz } from '@/util/archive'

const roots: string[] = []
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

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

function preservedArchive() {
  const artifactRoot = tempRoot('rfc349-restore-preserved-')
  const operationId = 'dbm_preserved_restore_01'
  const archiveChunk = createLogicalTableChunk({
    operationId,
    contract: CONTRACT,
    table: ARCHIVE,
    chunkIndex: 0,
    rows: [encodeLogicalRow(ARCHIVE, { id: 'legacy-1', value: 'history' })],
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
  const archiveDigest = writeDurableLogicalArtifact(
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
    expectedLegacyArchiveFileDigest: archiveDigest,
    contract: CONTRACT,
  })
}

async function postgresqlBackup(): Promise<{ readonly appHome: string; readonly path: string }> {
  const appHome = tempRoot('rfc349-restore-backup-')
  writeFileSync(join(appHome, 'config.json'), '{"from":"backup"}')
  const activeRows = [encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'portable' })]
  const result = await createPortableBackupArchive({
    appHome,
    now: 7,
    application: {
      async exportWorkflows(destination) {
        writeFileSync(join(destination, 'workflow.yaml'), 'name: restored')
        return 1
      },
      async captureWorktrees() {},
    },
    async exportDatabase({ logicalArtifactRoot, operationId }) {
      const receipt = await exportLogicalDatabaseArtifact({
        operationId,
        sourceProvider: 'postgresql',
        sourceGenerationId: 'dbg_postgresql_source_01',
        source: {
          provider: 'postgresql',
          async assertUnchanged() {},
          async readChunk(table, afterKey) {
            expect(table.id).toBe(ACTIVE.id)
            return afterKey === null ? activeRows : []
          },
        },
        expectedTableRows: { [ACTIVE.id]: 1 },
        contract: CONTRACT,
        artifactRoot: logicalArtifactRoot,
        preservedArchive: preservedArchive(),
        now: () => 7,
      })
      return {
        migration: { lastHash: null, lastCreatedAt: null },
        database: {
          format: 'agent-workflow-logical-database-v1',
          provider: 'postgresql',
          sourceGenerationId: 'dbg_postgresql_source_01',
          schemaDigest: CONTRACT.digest,
          logicalPath: 'database/logical',
          envelopeFileDigest: receipt.envelopeFileDigest,
          rawSqlitePath: null,
        },
      }
    },
  })
  return { appHome, path: result.path }
}

function target(
  provider: 'sqlite' | 'postgresql',
  operationId: string,
  calls: string[],
  rows: CanonicalLogicalRow[],
): LogicalDatabaseRestoreTarget {
  return {
    provider,
    operationId,
    async prepare() {
      calls.push('prepare')
    },
    async copyChunk(table, chunk) {
      calls.push(`copy:${table.id}:${chunk.payload.chunkIndex}`)
      rows.push(...chunk.payload.rows)
    },
    async finalizeSchema() {
      calls.push('finalize')
    },
  }
}

function postgresqlTarget(
  operationId: string,
  calls: string[],
  restoredRows: CanonicalLogicalRow[],
): PostgresqlLogicalTarget {
  return {
    ...target('postgresql', operationId, calls, restoredRows),
    provider: 'postgresql',
    async prepareGeneration() {},
    async activateGeneration() {},
    async assertReady() {},
    async firstLiveWriteAt() {
      return null
    },
    async retireGenerationIfUnwritten() {
      return true
    },
    async markFinalized() {},
    async close() {
      calls.push('close')
    },
  }
}

describe('RFC-349 portable database restore', () => {
  test('restores a PostgreSQL backup into an inactive SQLite target and then applies assets', async () => {
    const backup = await postgresqlBackup()
    const calls: string[] = []
    const rows: CanonicalLogicalRow[] = []
    const operationId = 'dbm_restore_sqlite_01'
    const result = await restorePortableDatabaseBackup({
      tarballPath: backup.path,
      appHome: backup.appHome,
      restoreOperationId: operationId,
      contract: CONTRACT,
      target: target('sqlite', operationId, calls, rows),
      filesystem: {
        async apply({ stagingDirectory, manifest }) {
          calls.push('assets')
          expect(manifest.database.provider).toBe('postgresql')
          expect(readFileSync(join(stagingDirectory, 'config.json'), 'utf8')).toContain('backup')
          expect(existsSync(join(stagingDirectory, 'workflows', 'workflow.yaml'))).toBe(true)
        },
      },
      now: () => 9,
    })

    expect(calls).toEqual(['prepare', 'copy:active_rows:0', 'finalize', 'assets'])
    expect(rows).toEqual([encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'portable' })])
    expect(result.receipt).toMatchObject({
      sourceProvider: 'postgresql',
      targetProvider: 'sqlite',
      rowsRestored: 1,
      archiveRowsPreserved: 1,
    })
    expect(existsSync(join(backup.appHome, 'backups', `.logical-restore-${operationId}`))).toBe(
      false,
    )
  })

  test('rejects an outer-provider/envelope mismatch before target prepare', async () => {
    const backup = await postgresqlBackup()
    const extracted = tempRoot('rfc349-restore-forged-')
    await extractTarGz(backup.path, extracted)
    writeManifest(extracted, {
      manifestVersion: 2,
      kind: 'manual',
      createdAt: 7,
      appVersion: 'test',
      includesWorktrees: false,
      migration: { lastHash: null, lastCreatedAt: null },
      database: {
        format: 'agent-workflow-logical-database-v1',
        provider: 'sqlite',
        sourceGenerationId: 'dbg_postgresql_source_01',
        schemaDigest: CONTRACT.digest,
        logicalPath: 'database/logical',
        envelopeFileDigest: JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8'))
          .database.envelopeFileDigest as string,
        rawSqlitePath: null,
      },
    })
    const forged = join(backup.appHome, 'forged-provider.tar.gz')
    await tarGz(extracted, forged)
    const calls: string[] = []
    const operationId = 'dbm_restore_reject_01'
    let opened = false

    await expect(
      restorePortableDatabaseBackup({
        tarballPath: forged,
        appHome: backup.appHome,
        restoreOperationId: operationId,
        contract: CONTRACT,
        async openTarget() {
          opened = true
          return {
            target: target('postgresql', operationId, calls, []),
            async close() {},
          }
        },
        filesystem: { async apply() {} },
      }),
    ).rejects.toMatchObject({
      name: 'PortableDatabaseRestoreError',
      code: 'portable-restore-envelope',
    } satisfies Partial<PortableDatabaseRestoreError>)
    expect(opened).toBe(false)
    expect(calls).toEqual([])
  })

  test('opens and closes a PostgreSQL target around verified logical restore', async () => {
    const backup = await postgresqlBackup()
    const calls: string[] = []
    const restoredRows: CanonicalLogicalRow[] = []
    const operationId = 'dbm_restore_postgresql_01'
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_pg_restore_target_01',
    } as PostgresqlDatabaseRuntime
    const plan = { contractDigest: CONTRACT.digest } as PostgresqlSchemaPlan

    const result = await restorePostgresqlProviderBackup({
      tarballPath: backup.path,
      appHome: backup.appHome,
      restoreOperationId: operationId,
      runtime,
      contract: CONTRACT,
      plan,
      filesystem: {
        async apply() {
          calls.push('assets')
        },
      },
      now: () => 11,
      async openTarget(input) {
        calls.push('open')
        expect(input).toEqual({
          runtime,
          operationId,
          sourceGenerationId: 'dbg_postgresql_source_01',
          contract: CONTRACT,
          plan,
        })
        return postgresqlTarget(operationId, calls, restoredRows)
      },
    })

    expect(result.receipt).toMatchObject({
      sourceProvider: 'postgresql',
      targetProvider: 'postgresql',
      rowsRestored: 1,
    })
    expect(restoredRows).toEqual([encodeLogicalRow(ACTIVE, { id: 'active-1', value: 'portable' })])
    expect(calls).toEqual(['open', 'prepare', 'copy:active_rows:0', 'finalize', 'assets', 'close'])
  })

  test('releases the PostgreSQL target when filesystem application fails', async () => {
    const backup = await postgresqlBackup()
    const calls: string[] = []
    const operationId = 'dbm_restore_postgresql_failure_01'

    await expect(
      restorePostgresqlProviderBackup({
        tarballPath: backup.path,
        appHome: backup.appHome,
        restoreOperationId: operationId,
        runtime: {
          provider: 'postgresql',
          generationId: 'dbg_pg_restore_target_02',
        } as PostgresqlDatabaseRuntime,
        contract: CONTRACT,
        plan: { contractDigest: CONTRACT.digest } as PostgresqlSchemaPlan,
        filesystem: {
          async apply() {
            calls.push('assets')
            throw new Error('filesystem application failed')
          },
        },
        async openTarget() {
          return postgresqlTarget(operationId, calls, [])
        },
      }),
    ).rejects.toThrow('filesystem application failed')

    expect(calls).toEqual(['prepare', 'copy:active_rows:0', 'finalize', 'assets', 'close'])
  })
})
