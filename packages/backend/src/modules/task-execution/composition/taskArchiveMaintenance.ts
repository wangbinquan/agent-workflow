// RFC-359 W8-A：归档维护命令合一后只剩一份中立实现，两个 provider 共用。
export {
  ARCHIVED_TABLES,
  ARCHIVE_EXEMPT_TABLES,
  createDrizzleTaskArchiveMaintenanceCommand,
} from '../infrastructure/taskArchiveMaintenanceCommand'
export type {
  ArchivedTaskTreeReceipt,
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
  TaskArchiveManualRequest,
  TaskArchivePreviewTree,
  TaskArchiveSweepReceipt,
} from '../application/ports/taskArchiveMaintenanceCommand'
