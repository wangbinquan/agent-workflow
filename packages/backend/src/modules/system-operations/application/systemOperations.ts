import { projectAdminBackupReceipt } from '../domain/backup'
import { projectAdminRecoveryStatus } from '../domain/recovery'
import type { AdminBackupCoordinatorPort } from './ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from './ports/adminRestoreCoordinator'
import type { SystemOperationCommands } from '../public/commands'
import type { SystemOperationQueries } from '../public/queries'
import {
  backupResultViewSchema,
  cancelStagedRestoreResultSchema,
  localRestoreActivationSchema,
  recoveryStatusViewSchema,
  restorePlanViewSchema,
  stageRestoreResultSchema,
} from '../public/types'

export interface SystemOperationsApplication {
  readonly commands: SystemOperationCommands
  readonly queries: SystemOperationQueries
}

export function createSystemOperationsApplication(deps: {
  readonly backup: AdminBackupCoordinatorPort
  readonly restore: AdminRestoreCoordinatorPort
}): SystemOperationsApplication {
  const commands: SystemOperationCommands = {
    requestBackup: {
      async execute(_context, input) {
        return backupResultViewSchema.parse(
          projectAdminBackupReceipt(await deps.backup.request(input)),
        )
      },
    },
    stageRestore: {
      async execute(_context, input) {
        return stageRestoreResultSchema.parse(
          await deps.restore.stage(input.artifactRef, {
            noSafetyBackup: input.noSafetyBackup,
            noMigrate: input.noMigrate,
            skipIntegrityCheck: input.skipIntegrityCheck,
          }),
        )
      },
    },
    cancelStagedRestore: {
      execute() {
        return cancelStagedRestoreResultSchema.parse(deps.restore.cancel())
      },
    },
    activateLocalRestore: {
      async execute(_context, input) {
        return localRestoreActivationSchema.parse(
          await deps.restore.activateLocal(input.artifactRef, {
            noSafetyBackup: input.noSafetyBackup,
            noMigrate: input.noMigrate,
            skipIntegrityCheck: input.skipIntegrityCheck,
          }),
        )
      },
    },
  }
  const queries: SystemOperationQueries = {
    planLocalRestore: {
      async execute(_context, input) {
        return restorePlanViewSchema.parse(
          await deps.restore.plan(input.artifactRef, {
            skipIntegrityCheck: input.skipIntegrityCheck,
          }),
        )
      },
    },
    getRecoveryStatus: {
      execute() {
        return recoveryStatusViewSchema.parse(projectAdminRecoveryStatus(deps.restore.status()))
      },
    },
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    queries: Object.freeze(queries),
  })
}
