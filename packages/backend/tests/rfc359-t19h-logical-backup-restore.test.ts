// RFC-359 T19h — restore old logical bytes into the current index-only schema.
// Protocol cases use rows from the exact original SQLite migration prefix and
// explicitly control the target port. The selected PostgreSQL mechanism below
// uses the real source, export, reserved target and provider restore composition.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  inspectPortableDatabaseBackup,
  restorePortableDatabaseBackup,
} from '@/modules/system-operations/infrastructure/portableDatabaseRestore'
import { restorePostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderRestore'
import {
  createLogicalTableChunk,
  decodeLogicalRow,
  encodeLogicalRow,
  type LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  exportLogicalDatabaseArtifact,
  type LogicalDatabaseExportSource,
} from '@/platform/persistence/logicalDatabaseExport'
import {
  openVerifiedLogicalDatabaseArtifactSource,
  restoreLogicalDatabaseBackup,
  type LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalTableContract } from '@/platform/persistence/schemaContract'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { createPortableBackupArchive } from '@/services/portableBackupArchive'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { freezeAt } from './migration-freeze'

const roots: string[] = []
const providers = resolveTestProviders(process.env)
const oldOperation = 'dbm_t19h_restore_original'
const oldGeneration = 'dbg_t19h_restore_original'
const restoreOperation = 'dbm_t19h_restore_current'
const restoreGeneration = 'dbg_t19h_restore_current'
const opaqueInputs = ' { "old" : true, "empty": null } '
let history: PostgresqlMigrationHistory

beforeAll(async () => {
  history = await loadPostgresqlMigrationHistory()
})

afterEach(() => {
  for (const path of roots.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileTree(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {}
  function walk(prefix: string) {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = join(prefix, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[path] = digest(join(root, path))
    }
  }
  walk('')
  return files
}

async function historicalArtifact() {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc359-old-logical-restore-'))
  const migrations = freezeAt(history.root.sqliteMigration.last.index)
  roots.push(appHome, migrations)
  const sourcePath = join(appHome, 'db.sqlite')
  const restoreProvider = selectDatabaseSchemaProvider('sqlite')
  try {
    const db = createInMemoryDb(migrations)
    const sqlite: unknown = Reflect.get(db, '$client')
    if (!(sqlite instanceof Database)) throw new Error('expected the published SQLite fixture')
    try {
      sqlite
        .query(
          `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch, status, inputs, started_at, finished_at, cached_repo_id)
         VALUES (?, 'old restore task', 'old-workflow', '{}', '/tmp/repo', '/tmp/task', 'main', 'task', 'done', ?, 41, 42, 'old-repo')`,
        )
        .run('t19h-restored-task', opaqueInputs)
      sqlite.exec(
        `INSERT INTO code_artifacts (id, repo_path, commit_sha, base_sha, digest, keep_ref, generation, ref_count, state, created_at)
         VALUES ('t19h-restored-archive', '/tmp/repo', 'old-commit', 'old-base', 'sha256:old', 'refs/keep/t19h', 1, 0, 'live', 43)`,
      )
      writeFileSync(sourcePath, sqlite.serialize())
    } finally {
      sqlite.close()
    }
  } finally {
    restoreProvider()
  }
  const artifactRoot = join(appHome, 'old-logical')
  const source = openSqliteLogicalSource({ path: sourcePath, contract: history.root.contract })
  try {
    const snapshot = await source.preflight()
    const exported = await exportLogicalDatabaseArtifact({
      operationId: oldOperation,
      sourceProvider: 'sqlite',
      sourceGenerationId: oldGeneration,
      source: {
        provider: 'sqlite',
        assertUnchanged: () => source.assertUnchanged(snapshot),
        readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
      },
      expectedTableRows: snapshot.tableRows,
      contract: history.root.contract,
      artifactRoot,
      now: () => 47,
    })
    const preservedArchive = openVerifiedLogicalDatabaseArtifactSource({
      artifactRoot,
      expectedManifestDigest: exported.envelope.payload.logicalManifestDigest,
      expectedLegacyArchiveFileDigest: exported.envelope.payload.legacyArchiveFileDigest,
      contract: history.root.contract,
    })
    return { appHome, sourcePath, artifactRoot, exported, preservedArchive, snapshot }
  } finally {
    await source.close()
  }
}

async function archiveFromPostgresqlSource(
  fixture: Awaited<ReturnType<typeof historicalArtifact>>,
  source: LogicalDatabaseExportSource,
  tableRows: Readonly<Record<string, number>>,
) {
  return await createPortableBackupArchive({
    appHome: fixture.appHome,
    now: 53,
    application: {
      async exportWorkflows() {
        return 0
      },
      async captureWorktrees() {},
    },
    async exportDatabase({ logicalArtifactRoot, operationId }) {
      const receipt = await exportLogicalDatabaseArtifact({
        operationId,
        sourceProvider: 'postgresql',
        sourceGenerationId: oldGeneration,
        source,
        expectedTableRows: tableRows,
        contract: history.root.contract,
        artifactRoot: logicalArtifactRoot,
        preservedArchive: fixture.preservedArchive,
        now: () => 53,
      })
      return {
        migration: { lastHash: null, lastCreatedAt: null },
        database: {
          format: 'agent-workflow-logical-database-v1',
          provider: 'postgresql',
          sourceGenerationId: oldGeneration,
          schemaDigest: history.root.contract.digest,
          logicalPath: 'database/logical',
          envelopeFileDigest: receipt.envelopeFileDigest,
          rawSqlitePath: null,
        },
      }
    },
  })
}

async function protocolBackup() {
  const fixture = await historicalArtifact()
  const source = openSqliteLogicalSource({
    path: fixture.sourcePath,
    contract: history.root.contract,
  })
  try {
    const snapshot = await source.preflight()
    const tableRows = Object.fromEntries(
      history.root.contract.tables
        .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
        .map((table) => [table.id, snapshot.tableRows[table.id]!]),
    )
    // This is a controlled logical-export protocol, never a claimed PG source.
    const backup = await archiveFromPostgresqlSource(
      fixture,
      {
        provider: 'postgresql',
        assertUnchanged: () => source.assertUnchanged(snapshot),
        readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
      },
      tableRows,
    )
    return { ...fixture, backup }
  } finally {
    await source.close()
  }
}

function protocolTarget(failCopy?: Error) {
  const calls: string[] = []
  const chunks: Array<{ table: LogicalTableContract; chunk: LogicalTableChunk }> = []
  const target: LogicalDatabaseRestoreTarget = {
    provider: 'postgresql',
    operationId: restoreOperation,
    async prepare() {
      calls.push('prepare')
    },
    async copyChunk(table, chunk) {
      calls.push(`copy:${table.id}`)
      if (failCopy !== undefined) throw failCopy
      chunks.push({ table, chunk })
    },
    async finalizeSchema() {
      calls.push('finalize')
    },
  }
  return { target, calls, chunks }
}

describe('RFC-359 T19h old logical backup row bridge protocol', () => {
  test('inspects original bytes and restores re-encoded current chunks while preserving the entire old archive', async () => {
    const fixture = await protocolBackup()
    const oldFiles = fileTree(fixture.artifactRoot)
    const backupDigest = digest(fixture.backup.path)
    const inspection = await inspectPortableDatabaseBackup({
      tarballPath: fixture.backup.path,
      appHome: fixture.appHome,
      restoreOperationId: restoreOperation,
      contract: history.head.contract,
    })
    expect(inspection.envelope.payload.schemaDigest).toBe(history.root.contract.digest)
    expect(inspection.verification.archiveRows).toBe(1)
    const receiver = protocolTarget()
    const result = await restorePortableDatabaseBackup({
      tarballPath: fixture.backup.path,
      appHome: fixture.appHome,
      restoreOperationId: restoreOperation,
      contract: history.head.contract,
      async openTarget(input) {
        expect(input.contract).toEqual(history.head.contract)
        return {
          target: receiver.target,
          async close() {
            receiver.calls.push('close')
          },
        }
      },
      filesystem: {
        async apply() {
          receiver.calls.push('assets')
        },
      },
      now: () => 59,
    })
    const task = receiver.chunks.find((item) => item.table.id === 'tasks')!
    const oldTask = history.root.contract.tables.find((table) => table.id === 'tasks')!
    const original = fixture.preservedArchive.readChunk(oldTask, 0)
    expect(task.table).toEqual(history.head.contract.tables.find((table) => table.id === 'tasks')!)
    expect(task.chunk.payload.schemaDigest).toBe(history.head.contract.digest)
    expect(task.chunk.payload.operationId).toBe(restoreOperation)
    expect(task.chunk.payload.rows).toEqual(original.payload.rows)
    expect(decodeLogicalRow(task.table, task.chunk.payload.rows[0]!).inputs).toBe(opaqueInputs)
    expect(task.chunk.digest).not.toBe(original.digest)
    expect(receiver.chunks.some((item) => item.table.disposition === 'ARCHIVE_THEN_OMIT')).toBe(
      false,
    )
    expect(receiver.calls.slice(-3)).toEqual(['finalize', 'assets', 'close'])
    expect(result.receipt).toMatchObject({
      schemaDigest: history.head.contract.digest,
      archiveRowsPreserved: 1,
      completedAt: 59,
    })
    expect(result.manifest.database.schemaDigest).toBe(history.root.contract.digest)
    expect(fileTree(fixture.artifactRoot)).toEqual(oldFiles)
    expect(digest(fixture.backup.path)).toBe(backupDigest)
  })

  test('verifies both whole contracts before prepare and propagates the original copy failure with close', async () => {
    const fixture = await protocolBackup()
    const receiver = protocolTarget()
    const changedSource = {
      ...history.root.contract,
      tables: history.root.contract.tables.map((table) =>
        table.id === 'code_artifacts'
          ? { ...table, rationale: `${table.rationale} changed` }
          : table,
      ),
    }
    await expect(
      restoreLogicalDatabaseBackup({
        artifactRoot: fixture.artifactRoot,
        expectedEnvelopeFileDigest: fixture.exported.envelopeFileDigest,
        restoreOperationId: restoreOperation,
        contract: changedSource,
        targetContract: history.head.contract,
        target: receiver.target,
      }),
    ).rejects.toMatchObject({ code: 'logical-restore-artifact-corrupt' })
    expect(receiver.calls).toEqual([])
    const changedTarget = {
      ...history.head.contract,
      tables: history.head.contract.tables.map((table) =>
        table.id === 'tasks' ? { ...table, rationale: `${table.rationale} changed` } : table,
      ),
    }
    await expect(
      restoreLogicalDatabaseBackup({
        artifactRoot: fixture.artifactRoot,
        expectedEnvelopeFileDigest: fixture.exported.envelopeFileDigest,
        restoreOperationId: restoreOperation,
        contract: history.root.contract,
        targetContract: changedTarget,
        target: receiver.target,
      }),
    ).rejects.toMatchObject({ code: 'logical-restore-artifact-corrupt' })
    expect(receiver.calls).toEqual([])
    const failure = new Error('controlled restore copy failed')
    const failed = protocolTarget(failure)
    await expect(
      restorePortableDatabaseBackup({
        tarballPath: fixture.backup.path,
        appHome: fixture.appHome,
        restoreOperationId: restoreOperation,
        contract: history.head.contract,
        async openTarget() {
          return {
            target: failed.target,
            async close() {
              failed.calls.push('close')
            },
          }
        },
        filesystem: {
          async apply() {
            failed.calls.push('assets')
          },
        },
      }),
    ).rejects.toBe(failure)
    expect(failed.calls[0]).toBe('prepare')
    expect(failed.calls.at(-1)).toBe('close')
    expect(failed.calls).not.toContain('assets')
    expect(failed.calls).not.toContain('finalize')
  })

  test('rejects an unsupported current contract before opening the target', async () => {
    const fixture = await protocolBackup()
    let opened = false
    await expect(
      restorePortableDatabaseBackup({
        tarballPath: fixture.backup.path,
        appHome: fixture.appHome,
        restoreOperationId: restoreOperation,
        contract: { ...history.head.contract, digest: `sha256:${'4'.repeat(64)}` },
        async openTarget() {
          opened = true
          return { target: protocolTarget().target, async close() {} }
        },
        filesystem: { async apply() {} },
      }),
    ).rejects.toMatchObject({ code: 'portable-restore-schema' })
    expect(opened).toBe(false)
  })
})

describe('RFC-359 T19h selected provider restore mechanisms', () => {
  if (providers.includes('sqlite')) {
    test('the published SQLite prefix supplies the unchanged task and archive row bytes', async () => {
      const fixture = await historicalArtifact()
      const task = history.root.contract.tables.find((table) => table.id === 'tasks')!
      const chunk = fixture.preservedArchive.readChunk(task, 0)
      expect(decodeLogicalRow(task, chunk.payload.rows[0]!).inputs).toBe(opaqueInputs)
      expect(fixture.snapshot.tableRows.tasks).toBe(1)
      expect(fixture.snapshot.tableRows.code_artifacts).toBe(1)
      expect(encodeLogicalRow(task, decodeLogicalRow(task, chunk.payload.rows[0]!))).toEqual(
        chunk.payload.rows[0]!,
      )
    })
  }

  if (providers.includes('postgresql')) {
    test('a real old PostgreSQL logical backup restores into the current target and activates its current generation', async () => {
      const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
      if (urlEnv === undefined)
        throw new Error('selected PostgreSQL restore requires the real harness PostgreSQL URL')
      const fixture = await historicalArtifact()
      const originalFiles = fileTree(fixture.artifactRoot)
      const runtime = createPostgresqlDatabaseRuntime({
        config: {
          provider: 'postgresql',
          urlEnv,
          poolMax: 4,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
        generationId: restoreGeneration,
      })
      const pool = runtime.providerPool()
      try {
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        const originalTarget = await openPostgresqlLogicalTarget({
          runtime,
          operationId: oldOperation,
          sourceGenerationId: oldGeneration,
          contract: history.root.contract,
          plan: history.root.plan,
        })
        try {
          await restoreLogicalDatabaseBackup({
            artifactRoot: fixture.artifactRoot,
            expectedEnvelopeFileDigest: fixture.exported.envelopeFileDigest,
            restoreOperationId: oldOperation,
            contract: history.root.contract,
            target: originalTarget,
          })
          await originalTarget.prepareGeneration({
            generationId: oldGeneration,
            sourceGenerationId: oldGeneration,
          })
          await originalTarget.activateGeneration(oldGeneration, 61)
          await originalTarget.assertReady(oldGeneration)
          await originalTarget.markFinalized(61)
        } finally {
          await originalTarget.close()
        }
        const oldRows = await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')
        const source = await openPostgresqlLogicalSource({
          runtime,
          generationId: oldGeneration,
          contract: history.root.contract,
        })
        let backup: Awaited<ReturnType<typeof archiveFromPostgresqlSource>>
        try {
          const snapshot = await source.preflight()
          backup = await archiveFromPostgresqlSource(
            fixture,
            {
              provider: 'postgresql',
              assertUnchanged: () => source.assertUnchanged(snapshot),
              readChunk: (table, afterKey, limit) => source.readChunk(table, afterKey, limit),
            },
            snapshot.tableRows,
          )
        } finally {
          await source.close()
        }
        const backupDigest = digest(backup.path)
        await pool.unsafe('DROP SCHEMA agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA agent_workflow_meta CASCADE')
        const restored = await restorePostgresqlProviderBackup({
          tarballPath: backup.path,
          appHome: fixture.appHome,
          restoreOperationId: restoreOperation,
          runtime,
          contract: history.head.contract,
          plan: history.head.plan,
          targetGenerationId: restoreGeneration,
          filesystem: { async apply() {} },
          now: () => 67,
        })
        expect(await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')).toEqual(oldRows)
        expect(restored.receipt).toMatchObject({
          sourceProvider: 'postgresql',
          targetProvider: 'postgresql',
          schemaDigest: history.head.contract.digest,
          archiveRowsPreserved: 1,
        })
        expect(restored.envelope.payload.schemaDigest).toBe(history.root.contract.digest)
        expect(
          await pool.unsafe(
            'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ($2, $3) ORDER BY indexname',
            ['agent_workflow', 'idx_tasks_cached_repo_task', 'idx_tasks_overview_counts'],
          ),
        ).toEqual([
          { indexname: 'idx_tasks_cached_repo_task' },
          { indexname: 'idx_tasks_overview_counts' },
        ])
        expect(
          await pool.unsafe(
            'SELECT state, contract_digest FROM agent_workflow_meta.database_generations WHERE generation_id = $1',
            [restoreGeneration],
          ),
        ).toEqual([{ state: 'active', contract_digest: history.head.contract.digest }])
        const taskTable = history.head.contract.tables.find((table) => table.id === 'tasks')!
        const oldTaskTable = history.root.contract.tables.find((table) => table.id === 'tasks')!
        const expectedChunk = createLogicalTableChunk({
          operationId: restoreOperation,
          contract: history.head.contract,
          table: taskTable,
          chunkIndex: 0,
          rows: fixture.preservedArchive
            .readChunk(oldTaskTable, 0)
            .payload.rows.map((row) =>
              encodeLogicalRow(taskTable, decodeLogicalRow(oldTaskTable, row)),
            ),
        })
        expect(
          await pool.unsafe(
            'SELECT chunk_digest FROM agent_workflow_meta.logical_copy_chunks WHERE operation_id = $1 AND table_id = $2',
            [restoreOperation, 'tasks'],
          ),
        ).toEqual([{ chunk_digest: expectedChunk.digest }])
        expect(fileTree(fixture.artifactRoot)).toEqual(originalFiles)
        expect(digest(backup.path)).toBe(backupDigest)
      } finally {
        try {
          await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
          await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        } finally {
          await runtime.close()
        }
      }
    }, 120_000)
  }
})
