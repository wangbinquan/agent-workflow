import type { DatabaseProvider, LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { DatabasePreOpenRecoveryPort } from './ports/databasePreOpenRecovery'

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
export async function prepareDatabasePreOpenRecovery<THistory>(input: {
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
