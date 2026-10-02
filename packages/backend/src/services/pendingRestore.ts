// Standalone compatibility exports; the unchanged restore mechanisms belong to SO local.
export {
  hasPendingRestore,
  type PendingRestoreInfo,
  readPendingRestore,
  clearPendingRestore,
  type FailedRestoreInfo,
  listFailedRestores,
  type StagePendingRestoreOptions,
  stagePendingRestore,
  type ApplyPendingRestoreOptions,
  applyPendingRestoreIfAny,
} from '@/modules/system-operations/infrastructure/local/filePendingRestore'
