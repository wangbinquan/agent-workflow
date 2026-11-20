// RFC-524 — system-operations selections the compositions used to build when the caller left them out, and the
// pre-open recovery entry with its application use case, both moved here verbatim: production no longer calls them (the
// daemon stopped preparing pre-open recovery when RFC-395 II-b activated the epoch-2 schema; it prepares its database
// through the selected installation or the local file preparation). Tests exercise the local file effects through them.
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { DatabasePreOpenRecoveryPort } from '@/modules/system-operations/application/ports/databasePreOpenRecovery'
import { createFileDatabaseConfiguration } from '@/modules/system-operations/infrastructure/local/fileDatabaseConfiguration'
import { createFileDatabasePreOpenRecovery } from '@/modules/system-operations/infrastructure/local/fileDatabasePreOpenRecovery'
import {
  resolveDatabaseProviderRuntimeForRestore,
  type ResolvedDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import type { DatabaseProvider, LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { Paths } from '@/util/paths'

/**
 * `composeLocalSystemOperations`'s former fallbacks, in their former order: the local config file's database
 * configuration (read now, as the composition read it), then the restore provider runtime over the standard paths.
 */
export function composeStandaloneLocalSystemOperationsSelection(contract: LogicalSchemaContract): {
  readonly databaseConfig: DatabaseConfig
  readonly providerRuntime: ResolvedDatabaseProviderRuntime
} {
  const databaseConfig = createFileDatabaseConfiguration(Paths.config).read()
  const providerRuntime = resolveDatabaseProviderRuntimeForRestore({
    config: databaseConfig,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
  })
  return { databaseConfig, providerRuntime }
}

export type DaemonDatabasePreOpenRecoveryPort =
  DatabasePreOpenRecoveryPort<PostgresqlMigrationHistory>

// The former application use case (`application/prepareDatabasePreOpenRecovery.ts`), verbatim.
// RFC-359's exhaustive pre-open table retains the original provider decisions.
// SQLite applies the staged file restore before opening a client; the external
// server has no staged local database directory to apply at this point.
const PRE_OPEN_STAGED_RESTORE = {
  sqlite: async <THistory>(effects: DatabasePreOpenRecoveryPort<THistory>): Promise<boolean> =>
    await effects.applyStagedRestore(),
  postgresql: async (): Promise<boolean> => false,
} satisfies Record<
  DatabaseProvider,
  <THistory>(effects: DatabasePreOpenRecoveryPort<THistory>) => Promise<boolean>
>

export interface PreparedDatabasePreOpenRecovery<THistory> {
  readonly history: THistory
  applyStagedRestore(): Promise<boolean>
}

/** Reading generation and applying restore remain two separate error boundaries. */
async function prepareSelectedDatabasePreOpenRecovery<THistory>(input: {
  readonly contract: LogicalSchemaContract
  readonly effects: DatabasePreOpenRecoveryPort<THistory>
}): Promise<PreparedDatabasePreOpenRecovery<THistory>> {
  const { effects } = input
  const history = await effects.readMigrationHistory()
  const generation = await effects.readGeneration({ contract: input.contract, history })
  const payload = generation.kind === 'current' ? generation.generation.payload : generation.payload
  return {
    history,
    applyStagedRestore: () => PRE_OPEN_STAGED_RESTORE[payload.provider](effects),
  }
}

/** Pre-open effects are selected before either history or generation is read. */
export function prepareDatabasePreOpenRecovery<THistory>(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery: DatabasePreOpenRecoveryPort<THistory>
}): Promise<PreparedDatabasePreOpenRecovery<THistory>>
export function prepareDatabasePreOpenRecovery(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery?: DaemonDatabasePreOpenRecoveryPort
}): Promise<PreparedDatabasePreOpenRecovery<PostgresqlMigrationHistory>>
export async function prepareDatabasePreOpenRecovery<THistory>(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery?: DatabasePreOpenRecoveryPort<THistory>
}): Promise<
  | PreparedDatabasePreOpenRecovery<THistory>
  | PreparedDatabasePreOpenRecovery<PostgresqlMigrationHistory>
> {
  const recovery = input.recovery
  if (recovery !== undefined) {
    return await prepareSelectedDatabasePreOpenRecovery({
      contract: input.contract,
      effects: recovery,
    })
  }
  return await prepareSelectedDatabasePreOpenRecovery({
    contract: input.contract,
    effects: createFileDatabasePreOpenRecovery({
      contract: input.contract,
      migrationsFolder: input.migrationsFolder,
    }),
  })
}
