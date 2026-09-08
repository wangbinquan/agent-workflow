// RFC-349 — bootstrap/operations resolver for the verified live database
// generation. The durable pointer is authoritative; config only supplies the
// selected provider's mechanism settings and may never silently override it.

import { unhandledDatabaseProvider, type DatabaseProvider } from './databaseProviders'
import type { DatabaseConfig, DatabaseRuntimeTelemetry } from '@agent-workflow/shared'
import { openDb, type DbClient, type OpenDbOptions } from '@/db/client'
import {
  createPostgresqlDatabaseOperationalAdapter,
  createSqliteDatabaseOperationalAdapter,
  type DatabaseOperationalAdapter,
} from './databaseOperationalAdapter'
import {
  readDatabaseGeneration,
  type ResolvedDatabaseGeneration,
  type DatabaseGenerationBootstrapCandidate,
} from './generationStore'
import {
  createPostgresqlDatabaseRuntime,
  type InstrumentedPostgresqlDatabaseRuntime,
  type PostgresqlPoolOptions,
  type PostgresqlPool,
} from './postgresqlRuntime'
import {
  createPostgresqlDatabaseClient,
  type PostgresqlDatabaseClient,
} from './postgresqlDatabaseClient'
import type { LogicalSchemaContract } from './schemaContract'
import type { PostgresqlMigrationHistory } from './postgresqlMigrationSequence'
import { migratePostgresqlSchema, type PostgresqlMigrationReceipt } from './postgresqlMigrator'
import { readDbMigrationIdentity } from './sqlite/systemBackupManifest'

export class DatabaseProviderRuntimeError extends Error {
  constructor(
    public readonly code: 'database-provider-config-generation-mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseProviderRuntimeError'
  }
}

export type ResolvedDatabaseProviderRuntime =
  | Readonly<{
      provider: 'sqlite'
      generation: ResolvedDatabaseGeneration
      operations: DatabaseOperationalAdapter
      telemetry(): DatabaseRuntimeTelemetry
      /** Bootstrap-only mechanism factory; application/transport never receives this handle. */
      openClient(input: Omit<OpenDbOptions, 'path'>): DbClient
      close(): Promise<void>
    }>
  | Readonly<{
      provider: 'postgresql'
      generation: ResolvedDatabaseGeneration
      runtime: InstrumentedPostgresqlDatabaseRuntime
      operations: DatabaseOperationalAdapter
      telemetry(): DatabaseRuntimeTelemetry
      /** Bootstrap-only mechanism factory; application/transport never receives this handle. */
      openClient(): PostgresqlDatabaseClient
      close(): Promise<void>
    }>

export interface ResolveDatabaseProviderRuntimeOptions {
  readonly config: DatabaseConfig
  readonly sqlitePath: string
  readonly generationPointerPath: string
  readonly operationsRoot: string
  readonly contract: LogicalSchemaContract
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Infrastructure test seam; production uses Bun.SQL. */
  readonly postgresqlPoolFactory?: (options: PostgresqlPoolOptions) => PostgresqlPool
}

export function resolveDatabaseProviderSelection(options: {
  readonly config: DatabaseConfig
  readonly generationPointerPath: string
  readonly operationsRoot: string
  readonly contract: LogicalSchemaContract
}): ResolvedDatabaseGeneration {
  const generation = readDatabaseGeneration({
    pointerPath: options.generationPointerPath,
    migrationsDir: options.operationsRoot,
    expectedSchemaDigest: options.contract.digest,
  })
  if (generation.payload.provider !== options.config.provider) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      `database provider config is ${options.config.provider} but the verified live generation is ${generation.payload.provider}`,
    )
  }
  return generation
}

export type SqliteDatabaseProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'sqlite' }
>
export type PostgresqlDatabaseProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'postgresql' }
>

/**
 * RFC-359 W3-T16 —— 按 provider 收窄已解析的运行时。provider 字面量比较只许出现在
 * `platform/persistence/`（design §7 守卫 2）；bootstrap 拿到 union 后用这一处收窄，
 * 自己不再写 `provider === '…'` 分支。
 */
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: 'sqlite',
): SqliteDatabaseProviderRuntime
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: 'postgresql',
): PostgresqlDatabaseProviderRuntime
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: DatabaseProvider,
): ResolvedDatabaseProviderRuntime {
  if (runtime.provider !== provider) {
    throw new Error(
      `database-provider-runtime-mismatch: expected ${provider}, resolved ${runtime.provider}`,
    )
  }
  return runtime
}

function composeSqliteProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  generation: ResolvedDatabaseGeneration,
  initialClient: DbClient | null,
): SqliteDatabaseProviderRuntime {
  let client = initialClient
  return Object.freeze({
    provider: 'sqlite' as const,
    generation,
    operations: createSqliteDatabaseOperationalAdapter({
      path: options.sqlitePath,
      generationId: generation.payload.generationId,
    }),
    telemetry: () => Object.freeze({ version: 1, provider: 'sqlite', poolWait: null }),
    openClient(input: Omit<OpenDbOptions, 'path'>) {
      return (client ??= openDb({ ...input, path: options.sqlitePath }))
    },
    async close() {
      client?.$client.close()
      client = null
    },
  })
}

function composePostgresqlProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  generation: ResolvedDatabaseGeneration,
  runtime: InstrumentedPostgresqlDatabaseRuntime,
): PostgresqlDatabaseProviderRuntime {
  let client: PostgresqlDatabaseClient | null = null
  return Object.freeze({
    provider: 'postgresql' as const,
    generation,
    runtime,
    operations: createPostgresqlDatabaseOperationalAdapter({ runtime, contract: options.contract }),
    telemetry: runtime.telemetry,
    openClient: () => (client ??= createPostgresqlDatabaseClient(runtime)),
    close: () => runtime.close(),
  })
}

type PreparedDatabaseProviderMechanism =
  | { readonly provider: 'sqlite'; readonly client: DbClient }
  | { readonly provider: 'postgresql'; readonly runtime: InstrumentedPostgresqlDatabaseRuntime }

/** Transfer an actually prepared mechanism only after the strict pointer read. */
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: Extract<PreparedDatabaseProviderMechanism, { readonly provider: 'sqlite' }>,
): SqliteDatabaseProviderRuntime
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: Extract<PreparedDatabaseProviderMechanism, { readonly provider: 'postgresql' }>,
): PostgresqlDatabaseProviderRuntime
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: PreparedDatabaseProviderMechanism,
): ResolvedDatabaseProviderRuntime {
  const generation = resolveDatabaseProviderSelection(options)
  if (prepared.provider !== generation.payload.provider) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'prepared database mechanism differs from the verified generation',
    )
  }
  if (prepared.provider === 'sqlite') {
    return composeSqliteProviderRuntime(options, generation, prepared.client)
  }
  if (prepared.runtime.generationId !== generation.payload.generationId) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'prepared PostgreSQL runtime differs from the verified generation',
    )
  }
  return composePostgresqlProviderRuntime(options, generation, prepared.runtime)
}

export function resolveDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
): ResolvedDatabaseProviderRuntime {
  const generation = resolveDatabaseProviderSelection(options)
  if (generation.payload.provider === 'sqlite') {
    return composeSqliteProviderRuntime(options, generation, null)
  }
  if (generation.payload.provider !== 'postgresql') {
    return unhandledDatabaseProvider(generation.payload.provider)
  }
  if (options.config.provider !== 'postgresql') {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'verified PostgreSQL generation has no PostgreSQL runtime configuration',
    )
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: options.config,
    generationId: generation.payload.generationId,
    env: options.env,
    poolFactory: options.postgresqlPoolFactory,
  })
  return composePostgresqlProviderRuntime(options, generation, runtime)
}

interface PrepareDatabaseProviderRuntimeOptions extends ResolveDatabaseProviderRuntimeOptions {
  readonly candidate: DatabaseGenerationBootstrapCandidate
  readonly history: PostgresqlMigrationHistory
  readonly sqliteOptions: Omit<OpenDbOptions, 'path'>
  readonly beforeSqliteOpen?: () => void | Promise<void>
  readonly requireUpgradeLock: () => void
  readonly advancePointer: () => void
}

type PreparedDatabaseProviderSchema =
  | {
      readonly provider: 'sqlite'
      readonly runtime: SqliteDatabaseProviderRuntime
      readonly databaseConfig: DatabaseConfig
    }
  | {
      readonly provider: 'postgresql'
      readonly runtime: PostgresqlDatabaseProviderRuntime
      readonly databaseConfig: DatabaseConfig
      readonly receipt: PostgresqlMigrationReceipt
    }

/**
 * Called before opening SQLite, including before its migration backup. This
 * compares the known node boundary; openDb still verifies every receipt and the
 * complete physical schema on its actual connection before we publish a pointer.
 */
function assertSqliteUpgradeBoundary(
  options: PrepareDatabaseProviderRuntimeOptions,
  history: PostgresqlMigrationHistory,
  candidate: DatabaseGenerationBootstrapCandidate,
): void {
  if (candidate.kind !== 'schema-upgrade') return
  const observed = readDbMigrationIdentity(options.sqlitePath)
  const from = history.versions.findIndex(
    (version) => version.contract.digest === candidate.payload.schemaDigest,
  )
  const observedNode = history.versions.findIndex(
    (version) =>
      version.sqliteMigration.last.hash === observed?.lastHash &&
      version.sqliteMigration.last.folderMillis === observed?.lastCreatedAt,
  )
  if (from < 0 || observedNode < from) {
    throw new Error('SQLite schema receipts do not match the historical generation upgrade')
  }
}

/** Prepare the selected mechanism, then transfer that same instance after the
 * caller's durable pointer commit. Copy recovery and its lock remain with the
 * operation coordinator; engine dispatch and resource cleanup stay here. */
export async function prepareDatabaseProviderRuntime(
  options: PrepareDatabaseProviderRuntimeOptions,
): Promise<PreparedDatabaseProviderSchema> {
  const { candidate, config, history } = options
  const generation = candidate.kind === 'current' ? candidate.generation.payload : candidate.payload
  if (
    generation.provider === 'sqlite' &&
    (readDbMigrationIdentity(options.sqlitePath)?.lastCreatedAt ?? Infinity) <
      history.head.sqliteMigration.last.folderMillis
  )
    options.requireUpgradeLock()
  if (generation.provider !== config.provider) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      `database provider config is ${config.provider} but the verified live generation is ${generation.provider}`,
    )
  }
  const runtimeOptions = options
  if (generation.provider === 'sqlite') {
    assertSqliteUpgradeBoundary(options, history, candidate)
    await options.beforeSqliteOpen?.()
    const client = openDb({ ...options.sqliteOptions, path: options.sqlitePath })
    try {
      options.advancePointer()
      return {
        provider: 'sqlite',
        databaseConfig: config,
        runtime: adoptPreparedDatabaseProviderRuntime(runtimeOptions, {
          provider: 'sqlite',
          client,
        }),
      }
    } catch (error) {
      client.$client.close()
      throw error
    }
  }
  if (config.provider !== 'postgresql') {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'verified PostgreSQL generation has no PostgreSQL runtime configuration',
    )
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config,
    generationId: generation.generationId,
    env: options.env,
    poolFactory: options.postgresqlPoolFactory,
  })
  try {
    const receipt = await migratePostgresqlSchema({
      runtime,
      history,
      activeGeneration:
        generation.operationId === null
          ? undefined
          : {
              generationId: generation.generationId,
              operationId: generation.operationId,
              expectedContractDigest: generation.schemaDigest,
            },
      afterCommitted: () => options.advancePointer(),
    })
    return {
      provider: 'postgresql',
      databaseConfig: config,
      runtime: adoptPreparedDatabaseProviderRuntime(runtimeOptions, {
        provider: 'postgresql',
        runtime,
      }),
      receipt,
    }
  } catch (error) {
    await runtime.close()
    throw error
  }
}
