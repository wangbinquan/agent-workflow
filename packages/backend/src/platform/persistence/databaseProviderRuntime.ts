// RFC-349 — bootstrap/operations resolver for the verified live database
// generation. The durable pointer is authoritative; config only supplies the
// selected provider's mechanism settings and may never silently override it.

import type { DatabaseConfig } from '@agent-workflow/shared'
import {
  createPostgresqlDatabaseOperationalAdapter,
  createSqliteDatabaseOperationalAdapter,
  type DatabaseOperationalAdapter,
} from './databaseOperationalAdapter'
import { readDatabaseGeneration, type ResolvedDatabaseGeneration } from './generationStore'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
  type PostgresqlPoolOptions,
  type PostgresqlPool,
} from './postgresqlRuntime'
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
      close(): Promise<void>
    }>
  | Readonly<{
      provider: 'postgresql'
      generation: ResolvedDatabaseGeneration
      runtime: PostgresqlDatabaseRuntime
      operations: DatabaseOperationalAdapter
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
    return Object.freeze({
      provider: 'sqlite' as const,
      generation,
      operations: createSqliteDatabaseOperationalAdapter({
        path: options.sqlitePath,
        generationId: generation.payload.generationId,
      }),
      async close() {},
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
  return Object.freeze({
    provider: 'postgresql' as const,
    generation,
    runtime,
    operations: createPostgresqlDatabaseOperationalAdapter({
      runtime,
      contract: options.contract,
    }),
    close: () => runtime.close(),
  })
}
