// RFC-359 T19h: install the actual published SQLite/PG versions, copy nonempty
// rows with the original runner, then upgrade that live generation. PostgreSQL
// is selected by the same default provider list as the shared harness; a missing
// URL fails the selected case. The local SQLite case only checks the tiny source.
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createDatabaseMigrationRunner } from '@/modules/system-operations/application/databaseMigrationRunner'
import { createFileDatabaseMigrationArtifactStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationArtifactStore'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { createPostgresqlProviderBackup } from '@/modules/system-operations/infrastructure/postgresqlProviderBackup'
import { prepareDatabaseSchemaUpgrade } from '@/modules/system-operations/infrastructure/databaseSchemaUpgradeCoordinator'
import { createSqliteMigrationSafetyBackup } from '@/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup'
import {
  readDatabaseGeneration,
  writeDatabaseGenerationAtomic,
} from '@/platform/persistence/generationStore'
import { readLogicalDatabaseBackupEnvelope } from '@/platform/persistence/logicalDatabaseExport'
import { openVerifiedLogicalDatabaseArtifactSource } from '@/platform/persistence/logicalDatabaseRestore'
import { createPortableBackupApplicationAssets } from '@/platform/persistence/portableApplicationAssets'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { openPostgresqlLogicalSource } from '@/platform/persistence/postgresqlLogicalSource'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  createPostgresqlIndexUpgrade,
  postgresqlSqliteMigrationIdentity,
  postgresqlUpgradeReceipt,
  replayPostgresqlMigrationHistory,
  type PostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { digestSchemaContract } from '@/platform/persistence/schemaContract'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { readManifest } from '@/services/backupManifest'
import { extractTarGz } from '@/util/archive'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'
import { freezeAt, MIGRATIONS } from './migration-freeze'

const roots: string[] = []
const providers = resolveTestProviders(process.env)
const operationId = 'dbm_rfc359_historical_upgrade'
const generationId = 'dbg_pg_rfc359_historical_upgrade'
const sourceGenerationId = 'dbg_rfc359_historical_sqlite'
const recoveredTasksQuery = sql`SELECT id, inputs FROM tasks ORDER BY id`

afterEach(() => {
  for (const path of roots.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileTree(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = (prefix: string) => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const path = join(prefix, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[path] = fileDigest(join(root, path))
    }
  }
  walk('')
  return files
}

async function historicalSource(history: PostgresqlMigrationHistory) {
  const appHome = mkdtempSync(join(tmpdir(), 'rfc359-historical-upgrade-'))
  const migrations = freezeAt(history.root.sqliteMigration.last.index)
  roots.push(appHome, migrations)
  const sourcePath = join(appHome, 'db.sqlite')
  const db = createInMemoryDb(migrations)
  const sqlite: unknown = Reflect.get(db, '$client')
  if (!(sqlite instanceof Database)) throw new Error('expected the historical SQLite fixture')
  try {
    sqlite.exec(
      `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch, status, inputs, started_at, finished_at, cached_repo_id)
       VALUES ('t19h-task', 'historical task', 'historical-workflow', '{}', '/tmp/repository', '/tmp/task', 'main', 'task', 'done', ' { "source" : "old", "empty": null } ', 41, 42, 'historical-repo')`,
    )
    sqlite.exec(
      `INSERT INTO code_artifacts (id, repo_path, commit_sha, base_sha, digest, keep_ref, generation, ref_count, state, created_at)
       VALUES ('t19h-legacy', '/tmp/repository', 'old-commit', 'old-base', 'sha256:old', 'refs/keep/t19h', 1, 0, 'live', 43)`,
    )
    expect(
      sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('idx_tasks_cached_repo_task', 'idx_tasks_overview_counts')",
        )
        .all(),
    ).toEqual([])
    writeFileSync(sourcePath, sqlite.serialize())
  } finally {
    sqlite.close()
  }
  const source = openSqliteLogicalSource({ path: sourcePath, contract: history.root.contract })
  try {
    const snapshot = await source.preflight()
    return { appHome, sourcePath, source, snapshot }
  } catch (error) {
    await source.close()
    throw error
  }
}

describe('RFC-359 T19h published schema upgrade mechanisms', () => {
  if (providers.includes('sqlite')) {
    test('the original SQLite migration prefix produces real active and archive rows', async () => {
      const history = await loadPostgresqlMigrationHistory()
      const fixture = await historicalSource(history)
      try {
        expect(fixture.snapshot.tableRows.tasks).toBe(1)
        expect(fixture.snapshot.tableRows.code_artifacts).toBe(1)
        await fixture.source.assertUnchanged(fixture.snapshot)
      } finally {
        await fixture.source.close()
      }
    })
  }

  if (providers.includes('postgresql')) {
    for (const checkpoint of ['after:chunk', 'after:health-checked'] as const) {
      test(`real process interruption at ${checkpoint} resumes the old copy before the current schema`, async () => {
        const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
        if (urlEnv === undefined)
          throw new Error(
            'selected PostgreSQL copy recovery requires the real harness PostgreSQL URL',
          )
        const history = await loadPostgresqlMigrationHistory()
        const fixture = await historicalSource(history)
        await fixture.source.close()
        const config: Extract<DatabaseConfig, { provider: 'postgresql' }> = {
          provider: 'postgresql',
          urlEnv,
          poolMax: 4,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        }
        const runtime = createPostgresqlDatabaseRuntime({ config, generationId })
        try {
          await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
          await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        } finally {
          await runtime.close()
        }
        const pointerPath = join(fixture.appHome, 'database-generation.json')
        writeDatabaseGenerationAtomic({
          pointerPath,
          payload: {
            version: 1,
            generationId: sourceGenerationId,
            provider: 'sqlite',
            operationId: null,
            manifestDigest: null,
            schemaDigest: history.root.contract.digest,
            activatedAt: 0,
          },
        })
        const inputPath = join(fixture.appHome, 'worker-input.json')
        writeFileSync(
          inputPath,
          JSON.stringify({
            appHome: fixture.appHome,
            operationId,
            sourceGenerationId,
            config,
            checkpoint,
          }),
        )
        const sourceHash = fileDigest(fixture.sourcePath)
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, 'fixtures', 'rfc359-historical-copy-worker.ts'),
            inputPath,
          ],
          {
            cwd: join(import.meta.dir, '..'),
            stdout: 'pipe',
            stderr: 'pipe',
          },
        )
        const stderr = new Response(child.stderr).text()
        const reader = child.stdout.getReader()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const reached = await Promise.race([
            (async () => {
              let text = ''
              const decoder = new TextDecoder()
              while (true) {
                const value = await reader.read()
                if (value.done) throw new Error('old copy ended before its durable checkpoint')
                text += decoder.decode(value.value, { stream: true })
                const match = /RFC359_T19H_CHECKPOINT (\{[^\n]+\})\n/.exec(text)
                if (match) return JSON.parse(match[1]!) as { checkpoint: string; pid: number }
              }
            })(),
            child.exited.then(async (code): Promise<never> => {
              throw new Error(`old copy exited ${code}: ${await stderr}`)
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('old copy did not reach its durable checkpoint')),
                90_000,
              )
            }),
          ])
          expect(reached).toEqual({ checkpoint, pid: child.pid })
        } finally {
          clearTimeout(timer)
          child.kill('SIGKILL')
          await child.exited
          await stderr
          await reader.cancel()
        }
        const operationsRoot = join(fixture.appHome, 'database-migrations')
        const operationRoot = join(operationsRoot, operationId)
        const controlPlane = createDatabaseMigrationControlPlane({
          store: createFileDatabaseMigrationStore({ root: operationsRoot }),
        })
        const interrupted = controlPlane.readManifest(operationId)
        expect(interrupted.payload.failure).toBeNull()
        expect(interrupted.payload.phase).toBe(
          checkpoint === 'after:chunk' ? 'copying' : 'health-checked',
        )
        const chunks = Object.entries(fileTree(operationRoot)).filter(
          ([path]) => path.startsWith('chunks/') || path.startsWith('legacy-archive/'),
        )
        expect(chunks.length).toBeGreaterThan(0)
        let savedConfig: DatabaseConfig = { provider: 'sqlite' }
        const prepared = await prepareDatabaseSchemaUpgrade({
          config: savedConfig,
          sqlitePath: fixture.sourcePath,
          generationPointerPath: pointerPath,
          operationsRoot,
          contract: history.head.contract,
          sqliteOptions: { migrationsFolder: MIGRATIONS },
          lockPath: join(fixture.appHome, 'schema-upgrade.lock'),
          readConfig: () => savedConfig,
          writeConfig: (next) => {
            savedConfig = next
          },
        })
        try {
          expect(prepared.provider).toBe('postgresql')
          if (prepared.provider !== 'postgresql')
            throw new Error('historical copy did not activate PostgreSQL')
          expect(prepared.receipt).toMatchObject({
            applied: true,
            contractDigest: history.head.contract.digest,
          })
          expect<DatabaseConfig['provider']>(savedConfig.provider).toBe('postgresql')
          expect(controlPlane.get(operationId).phase).toBe('accepting-writes')
          expect(controlPlane.readManifest(operationId).payload.source.schemaDigest).toBe(
            history.root.contract.digest,
          )
          expect(
            readDatabaseGeneration({
              pointerPath,
              migrationsDir: operationsRoot,
              expectedSchemaDigest: history.head.contract.digest,
            }).payload.schemaDigest,
          ).toBe(history.head.contract.digest)
          expect(fileDigest(fixture.sourcePath)).toBe(sourceHash)
          for (const [path, digest] of chunks)
            expect(fileDigest(join(operationRoot, path))).toBe(digest)
          const client = prepared.runtime.openClient()
          expect(await client.all<{ id: string; inputs: string }>(recoveredTasksQuery)).toEqual([
            { id: 't19h-task', inputs: ' { "source" : "old", "empty": null } ' },
          ])
        } finally {
          await prepared.runtime.close()
        }
      }, 120_000)
    }

    test('a real two-step upgrade transaction converges with a fresh install without ordering receipts by time', async () => {
      const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
      if (urlEnv === undefined)
        throw new Error('selected PostgreSQL upgrade case requires the real harness PostgreSQL URL')
      const committed = await loadPostgresqlMigrationHistory()
      // A future index is test data for the multi-edge engine. The published
      // 0001 and immutable root are still the exact committed artifacts.
      const fixtureIndex = {
        name: 'idx_t19h_next',
        columns: ['status', 'id'],
        unique: false,
        where: null,
      }
      const { digest: _digest, ...body } = committed.head.contract
      const payload = {
        ...body,
        tables: body.tables.map((table) =>
          table.id === 'tasks' ? { ...table, indexes: [...table.indexes, fixtureIndex] } : table,
        ),
      }
      const contract = { ...payload, digest: digestSchemaContract(payload) }
      const sqliteMigrations = [
        ...committed.head.sqliteMigrations,
        {
          index: committed.head.sqliteMigrations.length,
          folderMillis: committed.head.sqliteMigration.last.folderMillis + 1,
          hash: createHash('sha256')
            .update('CREATE INDEX idx_t19h_next ON tasks(status, id);')
            .digest('hex'),
          tag: 'fixture_t19h_next',
        },
      ]
      const next = {
        contract,
        plan: buildPostgresqlSchemaPlan(contract),
        sqliteMigrations,
        sqliteMigration: postgresqlSqliteMigrationIdentity(sqliteMigrations),
      }
      const second = createPostgresqlIndexUpgrade({
        from: committed.head,
        to: next,
        sequence: 2,
        id: '0002_t19h_fixture',
        previousEntryDigest: committed.steps[0]!.digest,
      })
      const history = replayPostgresqlMigrationHistory(committed.root, [...committed.steps, second])
      const runtime = createPostgresqlDatabaseRuntime({
        generationId: 'dbg_t19h_multistep',
        config: {
          provider: 'postgresql',
          urlEnv,
          poolMax: 2,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 60_000,
          idleTimeoutMs: 30_000,
        },
      })
      const pool = runtime.providerPool()
      const clean = async () => {
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
      }
      const catalogs = async () => ({
        columns: await pool.unsafe(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'agent_workflow' ORDER BY table_name, ordinal_position",
        ),
        indexes: await pool.unsafe(
          "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'agent_workflow' ORDER BY tablename, indexname",
        ),
        contract: await pool.unsafe('SELECT * FROM agent_workflow_meta.schema_contract'),
      })
      try {
        await clean()
        await migratePostgresqlSchema({ runtime, plan: history.root.plan, now: () => 77 })
        await pool.unsafe(`INSERT INTO agent_workflow.tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path, base_branch, branch, status, inputs, started_at)
          VALUES ('multi-task', 'multi', 'old-workflow', '{}', '/tmp/repo', '/tmp/task', 'main', 'task', 'done', ' { "same": true } ', 41)`)
        const originalRows = await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')
        const baseline = await pool.unsafe('SELECT * FROM agent_workflow_meta.schema_migrations')
        await pool.unsafe('CREATE INDEX idx_t19h_next ON agent_workflow.tasks(id)')
        await expect(migratePostgresqlSchema({ runtime, history })).rejects.toMatchObject({
          code: 'postgresql-schema-prepare-failed',
        })
        expect(
          await pool.unsafe(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'agent_workflow' AND indexname IN ('idx_tasks_cached_repo_task', 'idx_tasks_overview_counts')",
          ),
        ).toEqual([])
        expect(await pool.unsafe('SELECT * FROM agent_workflow_meta.schema_migrations')).toEqual(
          baseline,
        )
        expect(await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')).toEqual(
          originalRows,
        )
        await pool.unsafe('DROP INDEX agent_workflow.idx_t19h_next')
        expect((await migratePostgresqlSchema({ runtime, history, now: () => 77 })).applied).toBe(
          true,
        )
        expect((await migratePostgresqlSchema({ runtime, history })).applied).toBe(false)
        expect(await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')).toEqual(
          originalRows,
        )
        const receipts = await pool.unsafe(
          'SELECT baseline_id, contract_digest, plan_digest, applied_at FROM agent_workflow_meta.schema_migrations ORDER BY baseline_id',
        )
        expect(receipts).toHaveLength(3)
        expect(receipts[0]).toEqual(baseline[0])
        for (const step of history.steps) {
          const receipt = postgresqlUpgradeReceipt(step)
          expect(receipts.find((row) => row.baseline_id === receipt.baselineId)).toEqual({
            baseline_id: receipt.baselineId,
            contract_digest: receipt.contractDigest,
            plan_digest: receipt.planDigest,
            applied_at: baseline[0]!.applied_at,
          })
        }
        const upgraded = await catalogs()
        await clean()
        expect((await migratePostgresqlSchema({ runtime, history })).applied).toBe(true)
        expect(await catalogs()).toEqual(upgraded)
        expect((await migratePostgresqlSchema({ runtime, history })).applied).toBe(false)
      } finally {
        await runtime.close()
      }
    }, 120_000)

    test('real old copy upgrades, rolls back failed DDL, repairs its pointer and retains backup/finalize', async () => {
      const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
      if (urlEnv === undefined)
        throw new Error('selected PostgreSQL upgrade case requires the real harness PostgreSQL URL')
      const history = await loadPostgresqlMigrationHistory()
      const fixture = await historicalSource(history)
      const operationsRoot = join(fixture.appHome, 'database-migrations')
      const operationRoot = join(operationsRoot, operationId)
      const pointerPath = join(fixture.appHome, 'database-generation.json')
      const config = {
        provider: 'postgresql' as const,
        urlEnv,
        poolMax: 4,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleTimeoutMs: 30_000,
      }
      const runtime = createPostgresqlDatabaseRuntime({ config, generationId })
      const pool = runtime.providerPool()
      const restoreProvider = selectDatabaseSchemaProvider('sqlite')
      let target: Awaited<ReturnType<typeof openPostgresqlLogicalTarget>> | undefined
      try {
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        const controlPlane = createDatabaseMigrationControlPlane({
          store: createFileDatabaseMigrationStore({ root: operationsRoot }),
          newOperationId: () => operationId,
          newOwnerId: () => 'dbo_rfc359_historical_upgrade',
        })
        controlPlane.start({
          idempotencyKey: 'rfc359-historical-upgrade',
          sourceGenerationId,
          sourceSchemaDigest: history.root.contract.digest,
          sourceDatabaseFingerprint: fixture.snapshot.databaseFingerprint,
          target: config,
          tableCounts: {
            source: history.root.contract.tables.length,
            active: history.root.contract.activeTableCount,
            archiveOnly: history.root.contract.archiveOnlyTableCount,
          },
          ownerLeaseMs: 60_000,
          now: Date.now(),
        })
        target = await openPostgresqlLogicalTarget({
          runtime,
          operationId,
          sourceGenerationId,
          contract: history.root.contract,
          plan: history.root.plan,
        })
        let targetDigest = history.root.contract.digest
        const runner = createDatabaseMigrationRunner({
          controlPlane,
          source: fixture.source,
          sourceSnapshot: fixture.snapshot,
          target,
          targetRuntime: runtime,
          contract: history.root.contract,
          targetSchemaDigest: () => targetDigest,
          admission: {
            freezeAndDrain: async () => undefined,
            reopenSqlite: async () => undefined,
            activatePostgresql: async () => undefined,
            openPostgresqlAdmission: async () => undefined,
          },
          safetyBackup: createSqliteMigrationSafetyBackup(),
          artifacts: createFileDatabaseMigrationArtifactStore({ operationsRoot }),
          generationPointerPath: pointerPath,
        })
        expect((await runner.run(operationId)).phase).toBe('accepting-writes')
        const oldPointer = readDatabaseGeneration({
          pointerPath,
          migrationsDir: operationsRoot,
          expectedSchemaDigest: history.root.contract.digest,
        }).payload
        const originalFiles = fileTree(operationRoot)
        const sourceDigest = fileDigest(fixture.sourcePath)
        const oldPointerDigest = fileDigest(pointerPath)
        const taskRows = await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')
        const copyRows = await pool.unsafe(
          'SELECT * FROM agent_workflow_meta.logical_copy_operations ORDER BY operation_id',
        )
        const chunkRows = await pool.unsafe(
          'SELECT * FROM agent_workflow_meta.logical_copy_chunks ORDER BY table_id, chunk_index',
        )
        const baselineRows = await pool.unsafe(
          'SELECT * FROM agent_workflow_meta.schema_migrations',
        )
        expect(taskRows).toHaveLength(1)
        expect(taskRows[0]?.inputs).toBe(' { "source" : "old", "empty": null } ')

        // An actual duplicate relation interrupts the second index statement;
        // PostgreSQL must undo the first CREATE INDEX in that transaction.
        const indexes = history.steps[0]!.indexAdditions.map((addition) => addition.statement)
        expect(indexes.map((statement) => statement.logicalId)).toEqual([
          'tasks:index:idx_tasks_cached_repo_task',
          'tasks:index:idx_tasks_overview_counts',
        ])
        await pool.unsafe('CREATE INDEX idx_tasks_overview_counts ON agent_workflow.tasks(id)')
        await expect(migratePostgresqlSchema({ runtime })).rejects.toMatchObject({
          code: 'postgresql-schema-prepare-failed',
        })
        expect(
          await pool.unsafe(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'agent_workflow' AND indexname = 'idx_tasks_cached_repo_task'",
          ),
        ).toEqual([])
        expect(await pool.unsafe('SELECT * FROM agent_workflow_meta.schema_migrations')).toEqual(
          baselineRows,
        )
        expect(await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')).toEqual(
          taskRows,
        )
        expect(fileDigest(pointerPath)).toBe(oldPointerDigest)
        await pool.unsafe('DROP INDEX agent_workflow.idx_tasks_overview_counts')

        const selected = {
          generationId,
          operationId,
          expectedContractDigest: history.root.contract.digest,
        }
        const pointerFailure = new Error('injected pointer write interruption after real PG COMMIT')
        await expect(
          migratePostgresqlSchema({
            runtime,
            activeGeneration: selected,
            now: () => Number(baselineRows[0]!.applied_at),
            afterCommitted: () => {
              throw pointerFailure
            },
          }),
        ).rejects.toBe(pointerFailure)
        expect(fileDigest(pointerPath)).toBe(oldPointerDigest)
        const committedIndexes = await pool.unsafe(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'agent_workflow' AND indexname IN ('idx_tasks_cached_repo_task', 'idx_tasks_overview_counts') ORDER BY indexname",
        )
        expect(committedIndexes).toHaveLength(2)
        const prepared = await prepareDatabaseSchemaUpgrade({
          config,
          sqlitePath: fixture.sourcePath,
          generationPointerPath: pointerPath,
          operationsRoot,
          contract: history.head.contract,
          sqliteOptions: { migrationsFolder: MIGRATIONS },
          lockPath: join(fixture.appHome, 'schema-upgrade.lock'),
          readConfig: () => config,
          writeConfig: () => {
            throw new Error('settled old copy must not rewrite config')
          },
        })
        try {
          expect(prepared.provider).toBe('postgresql')
          if (prepared.provider !== 'postgresql')
            throw new Error('expected the prepared PG runtime')
          expect(prepared.receipt.applied).toBe(false)
          targetDigest = prepared.receipt.contractDigest
          const preparedClient = prepared.runtime.openClient()
          expect(prepared.runtime.openClient()).toBe(preparedClient)
        } finally {
          await prepared.runtime.close()
        }
        expect(
          readDatabaseGeneration({
            pointerPath,
            migrationsDir: operationsRoot,
            expectedSchemaDigest: history.head.contract.digest,
          }).payload,
        ).toEqual({ ...oldPointer, schemaDigest: history.head.contract.digest })
        expect(fileTree(operationRoot)).toEqual(originalFiles)
        expect(fileDigest(fixture.sourcePath)).toBe(sourceDigest)
        expect(await pool.unsafe('SELECT * FROM agent_workflow.tasks ORDER BY id')).toEqual(
          taskRows,
        )
        expect(
          await pool.unsafe(
            'SELECT * FROM agent_workflow_meta.logical_copy_operations ORDER BY operation_id',
          ),
        ).toEqual(copyRows)
        expect(
          await pool.unsafe(
            'SELECT * FROM agent_workflow_meta.logical_copy_chunks ORDER BY table_id, chunk_index',
          ),
        ).toEqual(chunkRows)

        // Exercise the real live PG source and preserved old archive, with no
        // replacement source factory. Its receipts deliberately share a time.
        writeFileSync(join(fixture.appHome, 'config.json'), JSON.stringify({ database: config }))
        const client = createPostgresqlDatabaseClient(runtime)
        const backup = await createPostgresqlProviderBackup({
          appHome: fixture.appHome,
          operationsRoot,
          runtime,
          application: createPortableBackupApplicationAssets({ db: client }),
        })
        const extracted = join(fixture.appHome, 'extracted')
        await extractTarGz(backup.path, extracted)
        const manifest = readManifest(extracted)
        expect(manifest).toMatchObject({
          manifestVersion: 2,
          database: { provider: 'postgresql', schemaDigest: history.head.contract.digest },
        })
        if (manifest?.manifestVersion !== 2)
          throw new Error('expected the actual portable backup manifest')
        const artifactRoot = join(extracted, manifest.database.logicalPath)
        const envelope = readLogicalDatabaseBackupEnvelope({
          artifactRoot,
          expectedFileDigest: manifest.database.envelopeFileDigest,
        })
        expect(envelope.payload.archiveRows).toBe(1)
        expect(envelope.payload.activeRows).toBeGreaterThanOrEqual(1)
        const restored = openVerifiedLogicalDatabaseArtifactSource({
          artifactRoot,
          expectedManifestDigest: envelope.payload.logicalManifestDigest,
          expectedLegacyArchiveFileDigest: envelope.payload.legacyArchiveFileDigest,
          contract: history.head.contract,
        })
        const archivedTable = history.head.contract.tables.find(
          (table) => table.id === 'code_artifacts',
        )!
        expect(restored.readChunk(archivedTable, 0).payload.rows).toHaveLength(1)
        expect(fileTree(operationRoot)).toEqual(originalFiles)
        expect((await runner.finalize(operationId)).phase).toBe('finalized')
        const finalReceipt = JSON.parse(readFileSync(join(operationRoot, 'receipt.json'), 'utf8'))
        expect(finalReceipt.schemaDigest).toBe(history.root.contract.digest)
        expect(
          readDatabaseGeneration({
            pointerPath,
            migrationsDir: operationsRoot,
            expectedSchemaDigest: history.head.contract.digest,
          }).payload.schemaDigest,
        ).toBe(history.head.contract.digest)
        expect(
          (await migratePostgresqlSchema({ runtime, activeGeneration: selected })).applied,
        ).toBe(false)
      } finally {
        try {
          await target?.close()
        } finally {
          try {
            await fixture.source.close()
          } finally {
            try {
              await runtime.close()
            } finally {
              restoreProvider()
            }
          }
        }
      }
    }, 120_000)
  }
})

// No network: only the pool response is controlled. These cases still execute
// the real business-query compiler and reserved logical-source query emitter.
function queryRuntime(answer: (query: string) => readonly Record<string, unknown>[]) {
  const executions: Array<{
    scope: 'pool' | 'snapshot'
    query: string
    parameters: readonly unknown[] | undefined
  }> = []
  let releases = 0
  const execute = (
    scope: 'pool' | 'snapshot',
    query: string,
    parameters?: readonly unknown[],
  ): SqlRows => {
    executions.push({ scope, query, parameters })
    const rows = answer(query)
    return Object.assign(Promise.resolve(rows), {
      async values() {
        return rows.map((row) => Object.values(row))
      },
    })
  }
  const pool: PostgresqlPool = {
    unsafe: (query, parameters) => execute('pool', query, parameters),
    async reserve() {
      return {
        unsafe: (query, parameters) => execute('snapshot', query, parameters),
        release() {
          releases += 1
        },
      }
    },
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId,
    providerPool: () => pool,
    async health() {
      throw new Error('health is outside query compilation')
    },
    async readiness() {
      return {
        provider: 'postgresql',
        generationId,
        ok: true,
        latencyMs: 0,
        databaseFingerprint: 'pg:0123456789abcdef01234567',
        serverVersion: 'controlled query protocol',
        errorCategory: null,
      }
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('query-only runtime does not migrate')
    },
    async close() {},
  }
  return { runtime, executions, releases: () => releases }
}

test('the interruption readback compiles through the actual PostgreSQL client without a network', async () => {
  const controlled = queryRuntime(() => [])
  const restoreProvider = selectDatabaseSchemaProvider('postgresql')
  try {
    const client = createPostgresqlDatabaseClient(controlled.runtime)
    expect(await client.all(recoveredTasksQuery)).toEqual([])
    expect(controlled.executions).toEqual([
      {
        scope: 'pool',
        query: 'SELECT id, inputs FROM tasks ORDER BY id',
        parameters: [],
      },
    ])
  } finally {
    await controlled.runtime.close()
    restoreProvider()
  }
})

test('logical snapshot emits the current receipt join inside its reserved read-only transaction', async () => {
  const { head } = await loadPostgresqlMigrationHistory()
  const controlled = queryRuntime((query) => {
    if (query.includes('information_schema.tables')) {
      return head.contract.tables
        .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
        .map((table) => ({ table_name: table.providerTables.postgresql }))
    }
    if (query.includes('schema_migrations')) {
      expect(query).toBe(
        'SELECT migration.contract_digest FROM "agent_workflow_meta"."schema_migrations" migration INNER JOIN "agent_workflow_meta"."schema_contract" current_contract ON current_contract.contract_digest = migration.contract_digest WHERE current_contract.singleton = TRUE',
      )
      return [{ contract_digest: head.contract.digest }]
    }
    if (query.includes('database_generations'))
      return [{ state: 'active', contract_digest: head.contract.digest }]
    if (query.includes('count(*)')) return [{ count: '0' }]
    return []
  })
  const source = await openPostgresqlLogicalSource({
    runtime: controlled.runtime,
    generationId,
    contract: head.contract,
  })
  try {
    await source.preflight()
    expect(controlled.executions.every((entry) => entry.scope === 'snapshot')).toBe(true)
    expect(controlled.executions[0]?.query).toBe(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    )
    expect(
      controlled.executions.filter((entry) => entry.query.includes('schema_migrations')),
    ).toHaveLength(1)
  } finally {
    await source.close()
    await controlled.runtime.close()
  }
  expect(controlled.executions.at(-1)?.query).toBe('ROLLBACK')
  expect(controlled.releases()).toBe(1)
})
