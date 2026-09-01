import { composeSqliteFusionPersistence } from '@/modules/memory/composition/fusion'
import type { DbClient } from '@/db/client'
import {
  restoreBackup as restoreSqliteBackup,
  type RestoreOptions,
  type SqlitePostRestoreRecovery,
} from '@/platform/persistence/sqlite/systemProviderRestore'
import { repairFusionProvenance } from '@/services/fusion'
import {
  applyPendingRestoreIfAny as applyPendingSqliteRestore,
  type ApplyPendingRestoreOptions,
} from '@/services/pendingRestore'

/** Test bootstrap for the same required post-open recovery used in production. */
export const SQLITE_POST_RESTORE_RECOVERY: SqlitePostRestoreRecovery = Object.freeze({
  async recover({ db, appHome }: { readonly db: DbClient; readonly appHome: string }) {
    await repairFusionProvenance(composeSqliteFusionPersistence({ db, appHome }))
  },
})

export function restoreSqliteBackupForTest(
  tarballPath: string,
  options: Omit<RestoreOptions, 'postOpenRecovery'>,
) {
  return restoreSqliteBackup(tarballPath, {
    ...options,
    postOpenRecovery: SQLITE_POST_RESTORE_RECOVERY,
  })
}

export function applyPendingSqliteRestoreForTest(
  options: Omit<ApplyPendingRestoreOptions, 'postOpenRecovery'>,
) {
  return applyPendingSqliteRestore({
    ...options,
    postOpenRecovery: SQLITE_POST_RESTORE_RECOVERY,
  })
}
