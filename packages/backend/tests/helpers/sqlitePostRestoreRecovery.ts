import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'

import {
  restoreBackup as restoreSqliteBackup,
  type RestoreOptions,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import {
  applyPendingRestoreIfAny as applyPendingSqliteRestore,
  type ApplyPendingRestoreOptions,
} from '@/services/pendingRestore'

export function restoreSqliteBackupForTest(
  tarballPath: string,
  options: Omit<RestoreOptions, 'postOpenRecovery' | 'contract'>,
) {
  return restoreSqliteBackup(tarballPath, {
    contract: logicalSchemaContract,
    ...options,
  })
}

export function applyPendingSqliteRestoreForTest(
  options: Omit<ApplyPendingRestoreOptions, 'postOpenRecovery' | 'contract'>,
) {
  return applyPendingSqliteRestore({
    contract: logicalSchemaContract,
    ...options,
  })
}
