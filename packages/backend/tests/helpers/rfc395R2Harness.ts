import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
// RFC-395: native fixtures do not install an unused application database around every generation.
import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveTestProviders,
  resolvePostgresqlTestUrlEnv,
  closePostgresqlFixtureDatabases,
  type ProviderHarness,
} from './eachProvider'
import { Rfc395FixtureGeneration } from './rfc395FixtureGeneration'
import {
  createRfc395FixtureDatabase,
  createRfc395FixtureRuntime,
  type FixtureDatabase,
} from './rfc395FixturePostgresql'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type {
  PostgresqlPool,
  PostgresqlDatabaseRuntime,
} from '@/platform/persistence/postgresqlRuntime'
import {
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
  readonly referencePool: PostgresqlPool
  installFixture(key: string, install: () => Promise<void>): Promise<void>
  afterTest(cleanup: () => Promise<void>): void
  catalog(version: HistoryVersion): Promise<PostgresqlCatalogArtifact>
  installHead(
    version: HistoryVersion,
    options?: Partial<Omit<InstallHistoryHeadOptions, 'version'>>,
  ): Promise<void>
}
export function describeR2Providers(name: string, body: (harness: R2TargetHarness) => void): void {
  for (const provider of resolveTestProviders(process.env))
    describe(`${name} [${provider}]`, () =>
      describe('empty target generation', () => body(createR2TargetHarness(provider))))
}

/** Existing application/target parity tests still own their application harness. */
export function withR2TargetHarness(
  harness: ProviderHarness,
  body: (target: R2TargetHarness) => void,
): void {
  describe('empty target generation', () =>
    body(createR2TargetHarness(() => harness.capabilities.provider)))
}

function createR2TargetHarness(
  selection: DatabaseProvider | (() => DatabaseProvider),
): R2TargetHarness {
  let provider: DatabaseProvider = typeof selection === 'string' ? selection : undefined!
  let root: string
  let generation: Rfc395FixtureGeneration
  let referenceDatabase: FixtureDatabase | undefined
  let reference: ReturnType<typeof createRfc395FixtureRuntime> | undefined
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const sourceUrl = urlEnv ? process.env[urlEnv] : undefined
  let cache: HistoryCatalogCache
  // Artifacts are immutable plan-digest values, not part of a test's mutable database state.
  const artifacts: PostgresqlCatalogArtifact[] = []
  const pendingCatalogs = new Map<string, Promise<PostgresqlCatalogArtifact>>()
  const cleanups: (() => Promise<void>)[] = []
  let initialization: Promise<void> | undefined
  const initializeGeneration = async () => {
    provider = typeof selection === 'string' ? selection : selection()
    root ??= mkdtempSync(join(tmpdir(), 'aw-rfc395-r2-'))
    generation ??= new Rfc395FixtureGeneration(provider, root, sourceUrl)
    if (provider === 'postgresql' && !reference) {
      if (!sourceUrl)
        throw new Error('R2 PostgreSQL tests require AW_TEST_POSTGRESQL_URL or RFC357_DATABASE_URL')
      referenceDatabase ??= await createRfc395FixtureDatabase(sourceUrl)
      reference = createRfc395FixtureRuntime({
        generationId: 'dbg_rfc395_reference',
        config: {
          provider: 'postgresql',
          urlEnv: 'R2_REFERENCE_URL',
          poolMax: 1,
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 30_000,
          idleTimeoutMs: 30_000,
        },
        env: { R2_REFERENCE_URL: referenceDatabase.url },
      })
    }
  }
  const initialize = () =>
    (initialization ??= initializeGeneration().finally(() => {
      initialization = undefined
    }))
  const catalog = (version: HistoryVersion): Promise<PostgresqlCatalogArtifact> => {
    const key = version.postgresql.digest
    const existing = artifacts.find((artifact) => artifact.planDigest === key)
    if (existing) return Promise.resolve(existing)
    const pending = pendingCatalogs.get(key)
    if (pending) return pending
    const compiling = (async () => {
      const connection = await reference!.providerPool('migration').reserve()
      try {
        const artifact = await compilePostgresqlHistoryCatalog(connection, version.postgresql)
        artifacts.push(artifact)
        return artifact
      } finally {
        connection.release()
      }
    })().finally(() => pendingCatalogs.delete(key))
    pendingCatalogs.set(key, compiling)
    return compiling
  }
  // V1 can compile its immutable manifest before the first default-5s test starts.
  beforeAll(async () => {
    if (typeof selection === 'string') await initialize()
  }, 60_000)
  beforeEach(async () => {
    await initialize()
    await generation.reset()
    cache = new HistoryCatalogCache(postgresqlCatalogLoader(artifacts))
  }, 60_000)
  afterEach(async () => {
    const cancelled = await Promise.allSettled([
      generation?.cancelQueries(),
      reference?.cancelQueries(),
    ])
    const readers = await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
    const closed = await Promise.allSettled([generation?.closeCurrent(), reference?.close()])
    reference = undefined
    const errors = [...cancelled, ...readers, ...closed].flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    )
    if (errors.length) throw new AggregateError(errors, 'R2 fixture cleanup')
  }, 30_000)
  afterAll(async () => {
    await initialization?.catch(() => undefined)
    try {
      await closePostgresqlFixtureDatabases(
        [generation, reference].filter((value) => value !== undefined),
        referenceDatabase ? [referenceDatabase] : [],
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
      return generation.native
    },
    get sqlite() {
      return generation.sqlite
    },
    get sqlitePath() {
      return generation.sqlite.filename
    },
    get runtime() {
      return generation.runtime
    },
    get pool() {
      return generation.runtime.providerPool()
    },
    get referencePool() {
      return reference!.providerPool('migration')
    },
    get cache() {
      return cache
    },
    installFixture: (key, install) => generation.install(key, install),
    afterTest: (cleanup) => {
      cleanups.push(cleanup)
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
      if (provider === 'sqlite')
        await installHistoryHead(sqliteHistorySession(generation.sqlite), input)
      else
        await installHistoryHead(postgresqlHistorySession(generation.runtime.providerPool()), input)
    },
    apply: async (version, options = {}) => {
      if (provider === 'postgresql')
        version = { ...version, postgresqlCatalog: await catalog(version) }
      return await (provider === 'sqlite'
        ? applyHistoryVersion(sqliteHistorySession(generation.sqlite), { ...options, version })
        : applyHistoryVersion(postgresqlHistorySession(generation.runtime.providerPool()), {
            ...options,
            version,
          }))
    },
    admit: (binary) =>
      provider === 'sqlite'
        ? admitHistory(sqliteHistorySession(generation.sqlite), { binary, catalogCache: cache })
        : admitHistory(postgresqlHistorySession(generation.runtime.providerPool()), {
            binary,
            catalogCache: cache,
          }),
    async transaction(body) {
      const native = generation.native
      if (provider === 'sqlite') {
        const database = generation.sqlite
        database.exec('BEGIN')
        try {
          const value = await body(native)
          database.exec('COMMIT')
          return value
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
      const connection = await generation.runtime.providerPool().reserve()
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
