import { currentSqlitePath } from '@/platform/persistence/databaseProviderRuntime'
import { sqliteGenerationLayout } from '@/platform/persistence/sqliteGenerationDirectory'
// Standalone boot mechanisms, including the original per-operation path reads.
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { DatabasePreOpenRecoveryPort } from '../../application/ports/databasePreOpenRecovery'
import type { SqlitePostRestoreRecovery } from '@/platform/persistence/sqlite/systemProviderRestore'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/schema/history/logicalHistory'
import { Paths } from '@/util/paths'
import { readDatabaseSchemaUpgradeGeneration } from '../databaseMigrationCoordinator'
import { applyPendingRestoreIfAny, hasPendingRestore } from './filePendingRestore'
import { existsSync, readFileSync } from 'node:fs'

export function createFileDatabasePreOpenRecovery(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly postOpenRecovery?: () => SqlitePostRestoreRecovery
}): DatabasePreOpenRecoveryPort<PostgresqlMigrationHistory> {
  const { migrationsFolder, postOpenRecovery } = input
  return {
    readMigrationHistory: () => loadPostgresqlMigrationHistory({ headContract: input.contract }),
    readGeneration: ({ contract, history }) =>
      readDatabaseSchemaUpgradeGeneration({
        generationPointerPath: Paths.databaseGenerationPointer,
        operationsRoot: Paths.databaseMigrationsDir,
        contract,
        history,
      }),
    applyStagedRestore: async () => {
      if (!hasPendingRestore(Paths.root)) return false
      if (
        existsSync(Paths.databaseGenerationPointer) &&
        (
          JSON.parse(readFileSync(Paths.databaseGenerationPointer, 'utf8')) as {
            payload?: { version?: number }
          }
        ).payload?.version !== 2
      )
        throw new Error(
          'This is an epoch-1 installation. Use db migration restore-backup for the staged backup.',
        )
      return await applyPendingRestoreIfAny({
        contract: input.contract,
        appHome: Paths.root,
        dbPath: currentSqlitePath(
          Paths.databaseGenerationPointer,
          sqliteGenerationLayout(`dbg_${crypto.randomUUID()}`, Paths.root).databasePath,
        ),
        migrationsFolder,
        postOpenRecovery: postOpenRecovery?.(),
      })
    },
  }
}
