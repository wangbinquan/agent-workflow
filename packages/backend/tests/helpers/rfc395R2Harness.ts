import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
// RFC-395 II-b R2: native empty-engine fixtures; the existing epoch-1 harness is untouched.
import { afterAll, afterEach, beforeEach, describe } from 'bun:test'
import { SQL } from 'bun'
import { migrationPostgresqlRuntime } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeEachProvider,
  resolvePostgresqlTestUrlEnv,
  createPostgresqlFileDatabase,
  closePostgresqlFixtureDatabases,
  type ProviderHarness,
} from './eachProvider'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import {
  sqliteHistoryConnection,
  postgresqlHistoryConnection,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import {
  applyHistoryVersion,
  type ApplyHistoryOptions,
  installHistoryHead,
  type InstallHistoryHeadOptions,
} from '@/platform/persistence/schema/history/apply'
import {
  HistoryCatalogCache,
  compilePostgresqlHistoryCatalog,
  postgresqlCatalogLoader,
  type PostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/catalog'
import { admitHistory } from '@/platform/persistence/schema/history/admission'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'

export interface R2Harness {
  readonly provider: DatabaseProvider
  readonly native: HistoryConnection
  readonly sqlite: Database
  readonly sqlitePath: string
  readonly runtime: PostgresqlDatabaseRuntime
  readonly pool: PostgresqlPool
  readonly cache: HistoryCatalogCache
  table(name: string): string
  apply(version: HistoryVersion, options?: Omit<ApplyHistoryOptions, 'version'>): Promise<boolean>
  admit(binary: HistoryVersion): Promise<HistoryVersion>
  transaction<T>(body: (connection: HistoryConnection) => Promise<T>): Promise<T>
}
export interface R2TargetHarness extends R2Harness {
  catalog(version: HistoryVersion): Promise<PostgresqlCatalogArtifact>
  installHead(
    version: HistoryVersion,
    options?: Partial<Omit<InstallHistoryHeadOptions, 'version'>>,
  ): Promise<void>
}
export function describeR2Providers(name: string, body: (harness: R2TargetHarness) => void): void {
  describeEachProvider(name, (harness) => withR2TargetHarness(harness, body))
}

/** Canonical harness owns provider selection; these native generations exercise DDL before admission. */
export function withR2TargetHarness(
  harness: ProviderHarness,
  body: (target: R2TargetHarness) => void,
): void {
  // Child cleanup closes the admin connection before the canonical parent drops its own database.
  describe('empty target generation', () => body(createR2TargetHarness(harness)))
}

function createR2TargetHarness(harness: ProviderHarness): R2TargetHarness {
  let provider: DatabaseProvider
  let database: Database | undefined
  let root: string
  let runtime: PostgresqlDatabaseRuntime
  let reference: SQL
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const sourceUrl = urlEnv ? process.env[urlEnv] : undefined
  const databases: Awaited<ReturnType<typeof createPostgresqlFileDatabase>>[] = []
  let native: HistoryConnection
  let cache: HistoryCatalogCache
  let artifacts: PostgresqlCatalogArtifact[] = []
  const catalog = async (version: HistoryVersion): Promise<PostgresqlCatalogArtifact> => {
    const existing = artifacts.find((artifact) => artifact.planDigest === version.postgresql.digest)
    if (existing) return existing
    const connection = await (reference as unknown as PostgresqlPool).reserve()
    try {
      const artifact = await compilePostgresqlHistoryCatalog(connection, version.postgresql)
      artifacts.push(artifact)
      return artifact
    } finally {
      connection.release()
    }
  }
  beforeEach(async () => {
    provider = harness.capabilities.provider
    root ??= mkdtempSync(join(tmpdir(), 'aw-rfc395-r2-'))
    if (provider === 'postgresql' && !runtime) {
      if (!sourceUrl)
        throw new Error('R2 PostgreSQL tests require AW_TEST_POSTGRESQL_URL or RFC357_DATABASE_URL')
      // Administrative connections use the captured base URL and close after each operation.
      // A child DROP must never leave a session attached to the parent harness's database.
      for (let index = 0; index < 2; index += 1)
        databases.push(await createPostgresqlFileDatabase(sourceUrl))
      runtime = migrationPostgresqlRuntime(
        createPostgresqlDatabaseRuntime({
          generationId: 'dbg_rfc395_r2_engine',
          config: {
            provider: 'postgresql',
            urlEnv: 'R2_ENGINE_URL',
            poolMax: 2,
            connectTimeoutMs: 10_000,
            statementTimeoutMs: 30_000,
            idleTimeoutMs: 30_000,
          },
          env: { R2_ENGINE_URL: databases[0]!.url! },
        }),
      )
      reference = new SQL(databases[1]!.url!, { max: 1 })
    }
    if (provider === 'sqlite') {
      // History/old-binary admission needs an empty, reopenable generation file, not the epoch-1 fixture.
      database = new Database(join(root, `db-${crypto.randomUUID()}.sqlite`))
      database.exec('PRAGMA foreign_keys = ON')
      native = sqliteHistoryConnection(database)
    } else {
      const pool = runtime.providerPool()
      await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
      await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
      native = postgresqlHistoryConnection(pool)
    }
    artifacts = []
    cache = new HistoryCatalogCache(postgresqlCatalogLoader(artifacts))
  }, 60_000)
  afterEach(() => {
    database?.close()
    database = undefined
  })
  afterAll(async () => {
    try {
      if (provider === 'postgresql')
        await closePostgresqlFixtureDatabases(
          [runtime, reference].filter((pool) => pool !== undefined),
          databases,
        )
    } finally {
      if (root) rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
  return {
    get provider() {
      return provider
    },
    get native() {
      return native
    },
    get sqlite() {
      if (!database) throw new Error('R2 fixture is not a live SQLite generation')
      return database
    },
    get sqlitePath() {
      if (!database) throw new Error('R2 fixture is not a live SQLite generation')
      return database.filename
    },
    get runtime() {
      return runtime
    },
    get pool() {
      return runtime.providerPool()
    },
    get cache() {
      return cache
    },
    table: (name) => (provider === 'sqlite' ? `"${name}"` : `"agent_workflow"."${name}"`),
    catalog,
    async installHead(version, options = {}) {
      if (provider === 'postgresql')
        version = { ...version, postgresqlCatalog: await catalog(version) }
      const input = {
        generationId: 'dbg_r2_install_head',
        installPath: 'test-baseline' as const,
        ...options,
        version,
      }
      if (provider === 'sqlite') await installHistoryHead(sqliteHistorySession(database!), input)
      else await installHistoryHead(postgresqlHistorySession(runtime.providerPool()), input)
    },
    apply: async (version, options = {}) => {
      if (provider === 'postgresql')
        version = { ...version, postgresqlCatalog: await catalog(version) }
      return await (provider === 'sqlite'
        ? applyHistoryVersion(sqliteHistorySession(database!), { ...options, version })
        : applyHistoryVersion(postgresqlHistorySession(runtime.providerPool()), {
            ...options,
            version,
          }))
    },
    admit: (binary) =>
      provider === 'sqlite'
        ? admitHistory(sqliteHistorySession(database!), { binary, catalogCache: cache })
        : admitHistory(postgresqlHistorySession(runtime.providerPool()), {
            binary,
            catalogCache: cache,
          }),
    async transaction(body) {
      if (provider === 'sqlite') {
        database!.exec('BEGIN')
        try {
          const value = await body(native)
          database!.exec('COMMIT')
          return value
        } catch (error) {
          database!.exec('ROLLBACK')
          throw error
        }
      }
      const connection = await runtime.providerPool().reserve()
      try {
        return await connection.begin((transaction) =>
          body(postgresqlHistoryConnection(transaction)),
        )
      } finally {
        connection.release()
      }
    },
  }
}
