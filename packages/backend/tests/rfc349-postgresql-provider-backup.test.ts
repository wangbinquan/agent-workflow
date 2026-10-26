// RFC-349 T6 — the normal Settings/CLI backup is a provider-neutral archive:
// PostgreSQL contributes logical rows and carries frozen evidence in epoch-2 metadata,
// and never fabricates a db.sqlite or depends on pg_dump.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPostgresqlProviderBackup,
  type PostgresqlProviderBackupError,
} from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import { writeGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { persistenceHead } from '@/bootstrap/persistenceHead'
import { openDb } from '@/db/client'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { readLogicalDatabaseBackupEnvelope } from '@/platform/persistence/logicalDatabaseExport'
import { verifyEpochMetadataSnapshot } from '@/platform/persistence/schema/history/metadataSnapshot'
import type { PostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
} from '@/platform/persistence/postgresqlRuntime'
import { readManifest } from '@/services/backupManifest'
import type { PortableBackupApplicationAssets } from '@/services/portableBackupArchive'
import { captureWorktreeRows } from '@/services/worktreeBackup'
import { extractTarGz } from '@/util/archive'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { workflowFixture } from './helpers/model'

const roots: string[] = []
const CONTRACT = logicalSchemaContract
const archivedBytes = Buffer.from('{"id":"legacy-1","value":"preserved"}')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'rfc349-postgresql-backup-'))
  roots.push(value)
  return value
}

async function livePostgresqlFixture() {
  const appHome = tempRoot()
  const dbPath = join(appHome, 'native-fixture.sqlite')
  const db = openDb({ path: dbPath })
  let generationId: string
  try {
    await workflowFixture(db, { id: 'active-1', name: 'live', definition: '{}' })
    generationId = (
      db.$client
        .query("SELECT generation_id FROM aw_meta_generations WHERE state='active'")
        .get() as { generation_id: string }
    ).generation_id
    db.$client
      .query(
        "INSERT INTO aw_meta_migration_archives (run_id,archive_ref,unit_id,kind,source_table,format,rows,byte_size,bytes) VALUES ('frozen-run','legacy-1','unit-1','retired-table','code_artifacts','raw-chunk@1',1,?,?)",
      )
      .run(archivedBytes.byteLength, archivedBytes)
    db.$client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.$client.close()
  }
  writeGenerationPointerV2({
    pointerPath: join(appHome, 'database-generation.json'),
    payload: {
      version: 2,
      schemaEpoch: 2,
      generationId,
      provider: 'postgresql',
      role: 'installed',
      database: { kind: 'postgresql-target', profileRef: 'RFC349_TEST_DATABASE_URL' },
      contractDigest: persistenceHead().contract.contract.digest,
      planDigest: persistenceHead().postgresql.digest,
      operationId: null,
      manifestDigest: null,
      activatedAt: 1,
      previous: null,
    },
  })
  const worktreePath = join(appHome, 'active-worktree')
  const repoPath = join(appHome, 'cached-repo')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  writeFileSync(join(worktreePath, 'tracked.txt'), 'live PostgreSQL worktree\n')
  // RFC-359 W9：workflow / worktree 的行选择已经合成中立实现并由组合根注入，
  // 这条适配器不再自己拿裸连接池去查业务表——池上任何一条查询都是回归。
  const pool: PostgresqlPool = {
    async reserve() {
      throw new Error('provider backup assets must not reserve a connection')
    },
    unsafe(sql: string) {
      throw new Error(`PostgreSQL provider backup must not query the pool: ${sql}`)
    },
    async close() {},
  }
  const runtime = {
    provider: 'postgresql',
    generationId,
    providerPool: () => pool,
  } as PostgresqlDatabaseRuntime
  return { appHome, runtime, worktreePath, repoPath, generationId, dbPath }
}

/**
 * 归档信封用例只关心「一份 workflow YAML + 一份 worktree tar 进了包」，
 * 行选择本身的双引擎判据在
 * `rfc359-w9-system-operations-application-assets-conformance.test.ts` 里对真库跑。
 * worktree 那半仍走**真的**归档机制，tar 断言才有意义。
 */
function fixtureApplication(fixture: {
  readonly worktreePath: string
  readonly repoPath: string
}): PortableBackupApplicationAssets {
  return {
    async exportWorkflows(destination: string) {
      writeFileSync(
        join(destination, '01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml'),
        'id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\nname: PostgreSQL backup workflow\n',
        'utf-8',
      )
      return 1
    },
    async captureWorktrees(stagingDirectory: string) {
      await captureWorktreeRows(
        [
          {
            id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
            worktreePath: fixture.worktreePath,
            branch: 'agent-workflow/postgresql-backup',
            repoPath: fixture.repoPath,
            baseCommit: null,
          },
        ],
        stagingDirectory,
      )
    },
  }
}

// Portable adapter unit: canonical rows and metadata come from a real native
// SQLite fixture. The PostgreSQL snapshot mechanism is covered on the real
// provider by rfc359-w8-logical-source-conformance.test.ts.
async function logicalSource(
  fixture: Awaited<ReturnType<typeof livePostgresqlFixture>>,
  onClose: () => void,
): Promise<PostgresqlLogicalSource> {
  const source = openSqliteLogicalSource({ path: fixture.dbPath, contract: CONTRACT })
  const sqliteSnapshot = await source.preflight()
  const snapshot = Object.freeze({
    databaseFingerprint: sqliteSnapshot.databaseFingerprint,
    generationId: fixture.generationId,
    schemaDigest: CONTRACT.digest,
    totalRows: sqliteSnapshot.totalRows,
    tableRows: sqliteSnapshot.tableRows,
  })
  return {
    provider: 'postgresql',
    generationId: fixture.generationId,
    async preflight() {
      return snapshot
    },
    async assertUnchanged(expected) {
      expect(expected).toBe(snapshot)
      await source.assertUnchanged(sqliteSnapshot)
    },
    readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
    readMetadata: () => source.readMetadata!(),
    async close() {
      await source.close()
      onClose()
    },
  }
}

describe('RFC-349 PostgreSQL provider backup', () => {
  test('packages live PostgreSQL rows and preserved legacy rows without db.sqlite', async () => {
    const fixture = await livePostgresqlFixture()
    writeFileSync(join(fixture.appHome, 'config.json'), '{"database":{"provider":"postgresql"}}')
    mkdirSync(join(fixture.appHome, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(fixture.appHome, 'skills', 'demo', 'SKILL.md'), 'demo')
    let closed = 0

    const backup = await createPostgresqlProviderBackup({
      headContract: logicalSchemaContract,
      appHome: fixture.appHome,
      runtime: fixture.runtime,
      contract: CONTRACT,
      now: 5,
      includeWorktrees: true,
      application: fixtureApplication(fixture),
      openLogicalSource: async () => logicalSource(fixture, () => (closed += 1)),
    })

    const extracted = tempRoot()
    await extractTarGz(backup.path, extracted)
    expect(backup.contents).toEqual({ workflows: 1, skills: 1, config: true, db: true })
    expect(closed).toBe(1)
    expect(existsSync(join(extracted, 'db.sqlite'))).toBe(false)
    expect(existsSync(join(extracted, 'workflows', '01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml'))).toBe(true)
    expect(existsSync(join(extracted, 'worktrees', '01ARZ3NDEKTSV4RRFFQ69G5FAW.tar.gz'))).toBe(true)
    const manifest = readManifest(extracted)
    expect(manifest).toMatchObject({
      manifestVersion: 2,
      includesWorktrees: true,
      migration: { lastHash: null, lastCreatedAt: null },
      database: {
        provider: 'postgresql',
        sourceGenerationId: fixture.generationId,
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
      sourceGenerationId: fixture.generationId,
      archiveRows: 0,
      activeTableCount: 232,
      archiveOnlyTableCount: 0,
    })
    const nativeSource = openSqliteLogicalSource({ path: fixture.dbPath, contract: CONTRACT })
    try {
      const snapshot = await nativeSource.preflight()
      expect(envelope.payload.activeRows).toBe(snapshot.totalRows)
      expect(snapshot.tableRows.workflows).toBe(1)
      const metadata = verifyEpochMetadataSnapshot(
        JSON.parse(
          readFileSync(
            join(extracted, manifest.database.logicalPath, 'epoch2-metadata.json'),
            'utf8',
          ),
        ),
      )
      expect(metadata).toEqual(await nativeSource.readMetadata!())
      expect(
        metadata.payload.tables.find((table) => table.name === 'migration_archives')!.rows,
      ).toHaveLength(1)
    } finally {
      await nativeSource.close()
    }
  })

  test('refuses a PostgreSQL adapter when the durable live pointer is SQLite', async () => {
    const appHome = tempRoot()
    let opened = false
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_wrong_provider',
    } as PostgresqlDatabaseRuntime
    await expect(
      createPostgresqlProviderBackup({
        headContract: logicalSchemaContract,
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
          throw new Error('wrong provider must not open a source')
        },
      }),
    ).rejects.toMatchObject({
      name: 'PostgresqlProviderBackupError',
      code: 'postgresql-backup-generation',
    } satisfies Partial<PostgresqlProviderBackupError>)
    expect(opened).toBe(false)
  })
})
