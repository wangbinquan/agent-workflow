import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { LocalSystemOperationContext } from './types'
import type {
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  StartDatabaseMigrationInput,
} from './databaseMigrationTypes'

export interface DatabaseMigrationCommands {
  readonly preflight: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: DatabaseMigrationPreflightInput,
    ): Promise<DatabaseMigrationPreflightView>
  }
  readonly start: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: StartDatabaseMigrationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly resume: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly cancel: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly rollback: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
  readonly finalize: {
    execute(
      context: CommandContext | LocalSystemOperationContext,
      input: DatabaseMigrationOperationInput,
    ): Promise<DatabaseMigrationStatusView>
  }
}
