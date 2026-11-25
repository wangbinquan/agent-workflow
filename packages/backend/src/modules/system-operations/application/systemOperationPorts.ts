// RFC-550 (RFC-294 S9): the system operations application's command and query ports. They sat on `public/commands` and
// `public/queries` without any other module consuming them.
import type {
  ActivateLocalRestoreCommand,
  RequestBackupCommand,
  StageRestoreCommand,
} from '../public/commands'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  HostedBackupCatalog,
  HostedBackupId,
  HostedBackupVerification,
} from '@agent-workflow/shared'
import type { PlanLocalRestoreQuery } from '../public/queries'
import type { CancelStagedRestoreResult, RecoveryStatusView } from './systemOperationContracts'

export interface SystemOperationCommands {
  readonly requestBackup: RequestBackupCommand
  readonly stageRestore: StageRestoreCommand
  readonly cancelStagedRestore: CancelStagedRestoreCommand
  readonly activateLocalRestore: ActivateLocalRestoreCommand
}

export interface SystemOperationQueries {
  readonly hostedBackupCatalog?: {
    execute(context: QueryContext): Promise<HostedBackupCatalog>
  }
  readonly verifyHostedBackup?: {
    execute(context: QueryContext, input: HostedBackupId): Promise<HostedBackupVerification>
  }
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly getRecoveryStatus: GetRecoveryStatusQuery
}

export interface CancelStagedRestoreCommand {
  execute(context: CommandContext): CancelStagedRestoreResult
}

export interface GetRecoveryStatusQuery {
  execute(context: QueryContext): RecoveryStatusView
}
