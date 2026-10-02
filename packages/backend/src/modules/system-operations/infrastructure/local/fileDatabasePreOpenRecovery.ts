// Standalone boot mechanisms, including the original per-operation path reads.
import type { DatabasePreOpenRecoveryPort } from '../../application/ports/databasePreOpenRecovery'
import type { SqlitePostRestoreRecovery } from '@/platform/persistence/sqlite/systemProviderRestore'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import { Paths } from '@/util/paths'
import { readDatabaseSchemaUpgradeGeneration } from '../databaseMigrationCoordinator'
import { applyPendingRestoreIfAny } from './filePendingRestore'

export function createFileDatabasePreOpenRecovery(input: {
  readonly migrationsFolder: string
  readonly postOpenRecovery: () => SqlitePostRestoreRecovery
}): DatabasePreOpenRecoveryPort<PostgresqlMigrationHistory> {
  const { migrationsFolder, postOpenRecovery } = input
  return {
    readMigrationHistory: () => loadPostgresqlMigrationHistory(),
    readGeneration: ({ contract, history }) =>
      readDatabaseSchemaUpgradeGeneration({
        generationPointerPath: Paths.databaseGenerationPointer,
        operationsRoot: Paths.databaseMigrationsDir,
        contract,
        history,
      }),
    applyStagedRestore: () =>
      applyPendingRestoreIfAny({
        appHome: Paths.root,
        dbPath: Paths.db,
        migrationsFolder,
        postOpenRecovery: postOpenRecovery(),
      }),
  }
}
