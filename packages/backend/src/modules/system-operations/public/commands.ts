import type {
  ActivateLocalRestoreInput,
  CancelStagedRestoreResult,
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  LocalRestoreActivationResult,
  LocalSystemOperationContext,
  RequestBackupInput,
  BackupResultView,
  StageRestoreInput,
  StageRestoreResult,
  StartDatabaseMigrationInput,
} from './types'
import type { CommandContext } from '@/modules/identity-access/public/participants'

export interface RequestBackupCommand {
  execute(
    context: CommandContext | LocalSystemOperationContext,
    input: RequestBackupInput,
  ): Promise<BackupResultView>
}

export interface StageRestoreCommand {
  execute(
    context: CommandContext | LocalSystemOperationContext,
    input: StageRestoreInput,
  ): Promise<StageRestoreResult>
}

export interface CancelStagedRestoreCommand {
  execute(context: CommandContext): CancelStagedRestoreResult
}

export interface ActivateLocalRestoreCommand {
  execute(
    context: LocalSystemOperationContext,
    input: ActivateLocalRestoreInput,
  ): Promise<LocalRestoreActivationResult>
}

export interface SystemOperationCommands {
  readonly requestBackup: RequestBackupCommand
  readonly stageRestore: StageRestoreCommand
  readonly cancelStagedRestore: CancelStagedRestoreCommand
  readonly activateLocalRestore: ActivateLocalRestoreCommand
}

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
