import type { Config } from '@agent-workflow/shared'
export type { AdminBackupCoordinatorPort as DatabaseBackupEffects } from '../application/ports/adminBackupCoordinator'

export type { HostedObjectPublicationMaintenance } from '../infrastructure/crewstation/objectPublicationContract'

/** Catalog retention. Stale building backups are failed first; physical unpin
 * of released archives belongs to the hosted object maintenance job. */
export interface DatabaseBackupMaintenance {
  prune(input: {
    readonly retentionCount: number
    readonly retentionDays: number
    readonly maxTotalBytes?: number
    readonly protectedKeepCount?: number
  }): Promise<{ deleted: number; kept: number }>
}
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

// RFC-370: settings transport consumes the application, not a file path.
export interface ApplicationConfigurationCommands {
  read(): Promise<Config>
  update(patch: unknown): Promise<Config>
}

export type ConfigConcurrencyHotApplyInput = Pick<
  Config,
  | 'maxConcurrentNodes'
  | 'maxConcurrentScriptNodes'
  | 'maxConcurrentCodeHostCalls'
  | 'multiProcessSubprocessConcurrency'
  | 'maxActiveChildTasks'
  | 'maxInvocationDepth'
>

/** Bootstrap-captured daemon concurrency mutation. The implementation owns
 * the process-pool identity; the HTTP route never receives a provider client. */
export interface ConfigConcurrencyHotApplyCommand {
  apply(input: ConfigConcurrencyHotApplyInput): void | Promise<void>
}
