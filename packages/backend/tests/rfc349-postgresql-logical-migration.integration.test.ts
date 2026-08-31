// Run with RFC349_DATABASE_URL pointed at an empty disposable PostgreSQL 17+
// database. This is the real-driver acceptance path; ordinary unit runs skip it.

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { agents } from '@/db/schema'
import { createDatabaseMigrationControlPlane } from '@/modules/system-operations/application/databaseMigrationControlPlane'
import { createDatabaseMigrationRunner } from '@/modules/system-operations/application/databaseMigrationRunner'
import { createFileDatabaseMigrationStore } from '@/modules/system-operations/infrastructure/fileDatabaseMigrationStore'
import { createSqliteMigrationSafetyBackup } from '@/modules/system-operations/infrastructure/sqliteMigrationSafetyBackup'
import { readLogicalArtifactManifest } from '@/platform/persistence/logicalDatabaseArtifact'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { migratePostgresqlSchema } from '@/platform/persistence/postgresqlMigrator'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const realTest = process.env.RFC349_DATABASE_URL === undefined ? test.skip : test

describe('RFC-349 real SQLite to PostgreSQL logical migration', () => {
  realTest(
    'copies 178 active tables, archives six legacy tables and switches one verified generation',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc349-real-copy-'))
      roots.push(root)
      const sourcePath = join(root, 'db.sqlite')
      const drizzle = createInMemoryDb(MIGRATIONS)
      const sqlite = (drizzle as unknown as { $client: Database }).$client
      sqlite.exec(
        "INSERT INTO users (id, username, display_name, role, status, force_password_change, created_at, updated_at, schema_version, access_revision, git_name) VALUES ('usr-rfc349', 'rfc349', 'RFC 349', 'user', 'active', 1, 9007199254740993, 9007199254740993, 1, 0, '')",
      )
      sqlite.exec(
        "INSERT INTO code_artifacts (id, repo_path, commit_sha, base_sha, digest, keep_ref, generation, ref_count, state, created_at) VALUES ('legacy-rfc349', '/tmp/repo', 'abc', 'def', 'sha256:legacy', 'refs/keep/rfc349', 1, 0, 'live', 123)",
      )
      writeFileSync(sourcePath, sqlite.serialize())
      sqlite.close()

      const contract = buildLogicalSchemaContract()
      const plan = buildPostgresqlSchemaPlan(contract)
      const source = openSqliteLogicalSource({ path: sourcePath, contract })
      const sourceSnapshot = await source.preflight()
      const operationsDir = join(root, 'database-migrations')
      const controlPlane = createDatabaseMigrationControlPlane({
        store: createFileDatabaseMigrationStore({ root: operationsDir }),
        newOperationId: () => 'dbm_real_postgresql_01',
        newOwnerId: () => 'dbo_real_postgresql_01',
      })
      controlPlane.start({
        idempotencyKey: 'rfc349-real-postgresql-copy',
        sourceGenerationId: 'dbg_real_sqlite_01',
        sourceSchemaDigest: contract.digest,
        sourceDatabaseFingerprint: sourceSnapshot.databaseFingerprint,
        target: {
          provider: 'postgresql',
          urlEnv: 'RFC349_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
        tableCounts: {
          source: contract.tables.length,
          active: contract.activeTableCount,
          archiveOnly: contract.archiveOnlyTableCount,
        },
        ownerLeaseMs: 60_000,
        now: Date.now(),
      })
      const runtime = createPostgresqlDatabaseRuntime({
        config: {
          provider: 'postgresql',
          urlEnv: 'RFC349_DATABASE_URL',
          poolMax: 4,
          connectTimeoutMs: 5_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
        generationId: 'dbg_pg_real_postgresql_01',
      })
      const target = await openPostgresqlLogicalTarget({
        runtime,
        operationId: 'dbm_real_postgresql_01',
        sourceGenerationId: 'dbg_real_sqlite_01',
        contract,
        plan,
      })
      try {
        const runner = createDatabaseMigrationRunner({
          controlPlane,
          source,
          sourceSnapshot,
          target,
          targetRuntime: runtime,
          contract,
          admission: {
            freezeAndDrain: async () => undefined,
            reopenSqlite: async () => undefined,
            activatePostgresql: async () => undefined,
            openPostgresqlAdmission: async () => undefined,
          },
          safetyBackup: createSqliteMigrationSafetyBackup(),
          operationRoot: (operationId) => join(operationsDir, operationId),
          generationPointerPath: join(root, 'database-generation.json'),
          chunkRows: 25,
        })
        const status = await runner.run('dbm_real_postgresql_01')
        expect(status.phase).toBe('accepting-writes')
        expect(status.progress.tablesCompleted).toBe(184)

        const userRows = await runtime
          .providerPool()
          .unsafe('SELECT created_at FROM agent_workflow.users WHERE id = $1', ['usr-rfc349'])
        expect(String(userRows[0]?.created_at)).toBe('9007199254740993')
        const archivePresence = await runtime
          .providerPool()
          .unsafe(
            "SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'agent_workflow' AND table_name = 'code_artifacts'",
          )
        expect(String(archivePresence[0]?.count)).toBe('0')
        const artifact = readLogicalArtifactManifest(
          join(operationsDir, 'dbm_real_postgresql_01', 'logical-manifest.json'),
        )
        expect(artifact.payload.tables).toHaveLength(184)
        expect(
          artifact.payload.tables.find((table) => table.table === 'code_artifacts'),
        ).toMatchObject({ disposition: 'ARCHIVE_THEN_OMIT', rowCount: 1 })

        const liveDb = createPostgresqlDatabaseClient(runtime)
        await liveDb.insert(agents).values({ id: 'agent-rfc349', name: 'RFC 349 Agent' }).run()
        expect(await liveDb.select({ id: agents.id }).from(agents).all()).toContainEqual({
          id: 'agent-rfc349',
        })
        expect(await runner.status('dbm_real_postgresql_01')).toMatchObject({
          firstLiveWriteAt: expect.any(Number),
          rollback: { eligible: false, reason: 'reverse-migration-required' },
        })

        expect((await runner.finalize('dbm_real_postgresql_01')).phase).toBe('finalized')
      } finally {
        await target.close()
        await source.close()
      }
      expect((await migratePostgresqlSchema({ runtime })).applied).toBe(false)
      await runtime.close()
    },
    120_000,
  )
})
