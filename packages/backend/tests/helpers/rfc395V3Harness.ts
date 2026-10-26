import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
// V3 fixtures keep the frozen source and an independently empty target alive together.
import { afterAll, afterEach, beforeEach, describe } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/infrastructure/persistence/migrationMetaTables'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import {
  HistoryCatalogCache,
  compilePostgresqlHistoryCatalog,
  type PostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/catalog'
import { sqliteHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { installHistoryHead } from '@/platform/persistence/schema/history/apply'
import { admitHistory } from '@/platform/persistence/schema/history/admission'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type {
  ConversionTargetConnection,
  EpochTargetLocation,
} from '@/platform/persistence/migration/run/types'
import type { VersionedSourceReader } from '@/platform/persistence/migration/sourceTypes'
import { describeV2Providers, type V2Harness } from './rfc395V2Harness'
import { integrationInput } from './rfc395V2/integration'
import { seedFrozenPostgresqlSource } from './rfc395V3/sourceSeeds'
import { migrationPostgresqlRuntime } from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import {
  resolvePostgresqlTestUrlEnv,
  resolveTestProviders,
  createPostgresqlFileDatabase,
  closePostgresqlFixtureDatabases,
} from './eachProvider'

export interface V3Harness {
  readonly source: V2Harness
  readonly sourceProvider: DatabaseProvider
  readonly targetProvider: DatabaseProvider
  readonly target: ConversionTargetConnection
  readonly targetLocation: EpochTargetLocation
  readonly sqlite: Database
  readonly runtime: PostgresqlDatabaseRuntime
  createTargetRuntime(
    poolFactory: NonNullable<Parameters<typeof createPostgresqlDatabaseRuntime>[0]['poolFactory']>,
  ): PostgresqlDatabaseRuntime
  readonly appHome: string
  readonly operationId: string
  readonly generationId: string
  readonly operationRoot: string
  readonly pointerPath: string
  readonly daemonLockPath: string
  readonly operationLockPath: string
  readonly targetPath: string
  readonly head: HistoryVersion
  readonly metaTables: typeof EPOCH2_META_TABLES
  readonly catalogCache: HistoryCatalogCache
  catalog(): Promise<PostgresqlCatalogArtifact>
  /** Fresh-baseline catalog fixture only. V3-R tests use its no-seed conversion installer. */
  installHead(): Promise<void>
  admit(): Promise<HistoryVersion>
  input(
    options?: Partial<
      Pick<
        ConversionInput,
        | 'content'
        | 'operatorDecisions'
        | 'chunkLimit'
        | 'planTime'
        | 'candidateBuild'
        | 'sourceBackupId'
        | 'contentManifestDigest'
      >
    >,
  ): Promise<ConversionInput>
}

export function describeV3Providers(name: string, body: (harness: V3Harness) => void): void {
  describeV2Providers(name, (source) => {
    describe('same-provider target', () =>
      withV3Target(source, source.sourceHarness.provider, body))
  })
}
/** This lane requires both engines; explicit single-provider selections leave it to the dual lane. */
export function describeV3CrossProvider(name: string, body: (harness: V3Harness) => void): void {
  if (!resolveTestProviders(process.env).includes('postgresql')) return
  describeV2Providers(name, (source) => {
    if (source.sourceHarness.provider === 'sqlite')
      describe('SQLite source to PostgreSQL target', () => withV3Target(source, 'postgresql', body))
  })
}

function withV3Target(
  source: V2Harness,
  provider: DatabaseProvider,
  body: (h: V3Harness) => void,
): void {
  const seededSource: V2Harness = {
    ...source,
    async install(which) {
      const version = await source.install(which)
      if (source.sourceHarness.provider === 'postgresql')
        await seedFrozenPostgresqlSource(source, version)
      return version
    },
  }
  const operationId = 'dbm_e2_v3_contract_fixture'
  const generationId = 'dbg_v3_target_fixture'
  const relativePath = `databases/${generationId}/db.sqlite`
  const head = createHistoryVersion({ registry: persistenceSchema, slug: 'baseline' })
  let appHome: string
  let database: Database | undefined
  let targetRuntimeInput: Parameters<typeof createPostgresqlDatabaseRuntime>[0] | undefined
  let runtime: PostgresqlDatabaseRuntime | undefined
  let reference: PostgresqlDatabaseRuntime | undefined
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const sourceUrl = urlEnv ? process.env[urlEnv] : undefined
  const databases: Awaited<ReturnType<typeof createPostgresqlFileDatabase>>[] = []
  let target: ConversionTargetConnection
  let cache: HistoryCatalogCache
  let artifact: PostgresqlCatalogArtifact | undefined
  let targetHead = head
  const readers = new Set<VersionedSourceReader>()
  const catalog = async (): Promise<PostgresqlCatalogArtifact> => {
    if (!reference) throw new Error('V3 catalog requires the PostgreSQL reference database')
    if (artifact) return artifact
    const connection = await reference.providerPool().reserve()
    try {
      artifact = await compilePostgresqlHistoryCatalog(
        connection,
        head.postgresql,
        EPOCH2_META_TABLES,
      )
      return artifact
    } finally {
      connection.release()
    }
  }
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc395-v3-'))
    mkdirSync(join(appHome, 'database-migrations', operationId), { recursive: true })
    targetHead = head
    if (provider === 'sqlite') {
      const path = join(appHome, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      database = new Database(path)
      database.exec('PRAGMA foreign_keys = ON')
      const native = sqliteHistoryConnection(database)
      target = {
        ...native,
        async transaction(work) {
          database!.exec('BEGIN IMMEDIATE')
          try {
            const result = await work(native)
            database!.exec('COMMIT')
            return result
          } catch (error) {
            database!.exec('ROLLBACK')
            throw error
          }
        },
        async close() {
          database?.close()
          database = undefined
        },
      }
    } else {
      if (!databases.length) {
        if (!sourceUrl)
          throw new Error(
            'V3 PostgreSQL tests require AW_TEST_POSTGRESQL_URL or RFC357_DATABASE_URL',
          )
        for (let index = 0; index < 2; index += 1)
          databases.push(await createPostgresqlFileDatabase(sourceUrl))
      }
      const open = (index: number) => {
        const input: Parameters<typeof createPostgresqlDatabaseRuntime>[0] = {
          generationId,
          config: {
            provider: 'postgresql',
            urlEnv: 'V3_TARGET_URL',
            poolMax: 2,
            connectTimeoutMs: 10000,
            statementTimeoutMs: 30000,
            idleTimeoutMs: 30000,
          },
          env: { V3_TARGET_URL: databases[index]!.url! },
        }
        if (index === 0) targetRuntimeInput = input
        return migrationPostgresqlRuntime(createPostgresqlDatabaseRuntime(input))
      }
      // Tests that exercise owned-runtime closure must not poison the next test.
      runtime = open(0)
      reference ??= open(1)
      const pool = runtime.providerPool()
      await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
      await pool.unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
      target = openConversionTarget({ runtime })
    }
    cache = new HistoryCatalogCache(async () => catalog())
  }, 90000)
  afterEach(async () => {
    for (const reader of readers) await reader.close()
    readers.clear()
    await target?.close()
    await runtime?.close()
    runtime = undefined
    if (appHome) rmSync(appHome, { recursive: true, force: true })
  }, 60000)
  afterAll(async () => {
    await closePostgresqlFixtureDatabases(
      [runtime, reference].filter((pool) => pool !== undefined),
      databases,
    )
  }, 90000)
  body({
    source: seededSource,
    sourceProvider: source.sourceHarness.provider,
    targetProvider: provider,
    operationId,
    generationId,
    head,
    metaTables: EPOCH2_META_TABLES,
    get appHome() {
      return appHome
    },
    get operationRoot() {
      return join(appHome, 'database-migrations', operationId)
    },
    get pointerPath() {
      return join(appHome, 'database-generation.json')
    },
    get daemonLockPath() {
      return join(appHome, '.daemon.lock')
    },
    get operationLockPath() {
      return join(appHome, 'database-migrations', operationId, '.lock')
    },
    get targetPath() {
      return join(appHome, relativePath)
    },
    get target() {
      return target
    },
    get targetLocation(): EpochTargetLocation {
      return provider === 'sqlite'
        ? { kind: 'sqlite-file', relativePath }
        : { kind: 'postgresql-target', profileRef: 'env:V3_TARGET_URL' }
    },
    get sqlite() {
      if (!database) throw new Error('not a SQLite target')
      return database
    },
    get runtime() {
      if (!runtime) throw new Error('not a PostgreSQL target')
      return runtime
    },
    createTargetRuntime(poolFactory) {
      if (!targetRuntimeInput) throw new Error('not a PostgreSQL target')
      return createPostgresqlDatabaseRuntime({ ...targetRuntimeInput, poolFactory })
    },
    get catalogCache() {
      return cache
    },
    catalog,
    async installHead() {
      if (provider === 'postgresql') targetHead = { ...head, postgresqlCatalog: await catalog() }
      const options = {
        version: targetHead,
        metaTables: EPOCH2_META_TABLES,
        generationId,
        now: () => 123,
        installPath: 'test-baseline' as const,
      }
      if (provider === 'sqlite') await installHistoryHead(sqliteHistorySession(database!), options)
      else await installHistoryHead(postgresqlHistorySession(runtime!.providerPool()), options)
    },
    admit: () =>
      provider === 'sqlite'
        ? admitHistory(sqliteHistorySession(database!), {
            binary: targetHead,
            catalogCache: cache,
            metaTables: EPOCH2_META_TABLES,
          })
        : admitHistory(postgresqlHistorySession(runtime!.providerPool()), {
            binary: targetHead,
            catalogCache: cache,
            metaTables: EPOCH2_META_TABLES,
          }),
    async input(options = {}) {
      const input = await integrationInput(source, options)
      readers.add(input.source)
      return {
        ...input,
        ...options,
        targetGeneration: generationId,
        scratchRoot: join(appHome, 'scratch'),
      }
    },
  })
}
