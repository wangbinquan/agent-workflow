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

import type {
  EpochSwitchPlanInput,
  EpochSwitchTargetInput,
  EpochSwitchPlanView,
  EpochSwitchStatusView,
  EpochSwitchSummaryView,
  TraceInput,
  MigrationTraceResult,
  TaskRestrictionView,
} from './types'

export interface EpochSwitchApplication {
  withdrawAcknowledgements(input: {
    readonly operationId: string
    readonly decisions: readonly string[] | 'all'
  }): Promise<EpochSwitchPlanView>
  plan(input: EpochSwitchPlanInput): Promise<EpochSwitchPlanView>
  acknowledge(input: {
    readonly operationId: string
    /** Explicit plan item ids, one per acknowledged item (RFC-395: per-item operator confirmation). */
    readonly items: readonly string[]
    readonly reason: string
    readonly by: string
  }): Promise<EpochSwitchPlanView>
  run(input: {
    readonly operationId: string
    /** Material approval digest, never the full plan-document digest. */
    readonly approve?: string
    readonly newRun?: boolean
    readonly drainTimeoutMs?: number
  }): Promise<EpochSwitchStatusView>
  status(input: {
    readonly operationId?: string
  }): Promise<EpochSwitchStatusView | readonly EpochSwitchSummaryView[]>
  trace(
    input: TraceInput | { readonly operationId: string; readonly taskId: string },
  ): Promise<MigrationTraceResult | TaskRestrictionView>
  verify(input: { readonly operationId: string }): Promise<EpochSwitchStatusView>
  rollback(input: { readonly operationId: string }): Promise<EpochSwitchStatusView>
  complete(input: { readonly operationId: string }): Promise<EpochSwitchStatusView>
  discard(input: {
    readonly operationId: string
    readonly confirm: true
  }): Promise<EpochSwitchStatusView>
  receipt(input: {
    readonly operationId: string
    readonly kind: 'plan' | 'run' | 'activation' | 'switch' | 'rollback'
  }): Promise<{ readonly path: string | null; readonly json: string }>
  restoreBackup(input: {
    readonly artifact: string
    readonly target?: EpochSwitchTargetInput
    readonly restoreConfig?: boolean
    readonly contentRoot?: string
    readonly scratchUrlEnv?: string
  }): Promise<EpochSwitchPlanView>
}
