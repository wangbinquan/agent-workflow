// RFC-349 — bootstrap/operations resolver for the verified live database
// generation. The durable pointer is authoritative; config only supplies the
// selected provider's mechanism settings and may never silently override it.

import type { DatabaseConfig, DatabaseRuntimeTelemetry } from '@agent-workflow/shared'
import { openDb, type DbClient, type OpenDbOptions } from '@/db/client'
import {
  createPostgresqlDatabaseOperationalAdapter,
  createSqliteDatabaseOperationalAdapter,
  type DatabaseOperationalAdapter,
} from './databaseOperationalAdapter'
import { readDatabaseGeneration, type ResolvedDatabaseGeneration } from './generationStore'
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

export function resolveDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
): ResolvedDatabaseProviderRuntime {
  const generation = resolveDatabaseProviderSelection(options)

  if (generation.payload.provider === 'sqlite') {
    let client: DbClient | null = null
    return Object.freeze({
      provider: 'sqlite' as const,
      generation,
      operations: createSqliteDatabaseOperationalAdapter({
        path: options.sqlitePath,
        generationId: generation.payload.generationId,
      }),
      telemetry: () => Object.freeze({ version: 1, provider: 'sqlite', poolWait: null }),
      openClient(input: Omit<OpenDbOptions, 'path'>) {
        return (client ??= openDb({
          ...input,
          path: options.sqlitePath,
        }))
      },
      async close() {
        client?.$client.close()
        client = null
      },
    })
  }

  // The provider equality above narrows config independently of the pointer.
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
  let client: PostgresqlDatabaseClient | null = null
  return Object.freeze({
    provider: 'postgresql' as const,
    generation,
    runtime,
    operations: createPostgresqlDatabaseOperationalAdapter({
      runtime,
      contract: options.contract,
    }),
    telemetry: runtime.telemetry,
    openClient: () => (client ??= createPostgresqlDatabaseClient(runtime)),
    close: () => runtime.close(),
  })
}
