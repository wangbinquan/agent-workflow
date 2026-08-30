import type {
  ActivateLocalRestoreInput,
  CancelStagedRestoreResult,
  LocalRestoreActivationResult,
  LocalSystemOperationContext,
  RequestBackupInput,
  BackupResultView,
  StageRestoreInput,
  StageRestoreResult,
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
