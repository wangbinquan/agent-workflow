// RFC-370: select archive content at composition; both providers share the original coordinator.
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskArchiveContentPort } from '../application/ports/taskArchiveContent'
import type { TaskArchiveMaintenanceCommand } from '../application/ports/taskArchiveMaintenanceCommand'
import { createTaskArchiveContentCoordinator } from '../infrastructure/taskArchiveContentCoordinator'
import { createFileTaskArchiveContent } from '../infrastructure/local/fileTaskArchiveContent'

export {
  ARCHIVED_TABLES,
  ARCHIVE_EXEMPT_TABLES,
} from '../infrastructure/taskArchiveContentCoordinator'
export type {
  ArchivedTaskTreeReceipt,
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
  TaskArchiveManualRequest,
  TaskArchivePreviewTree,
  TaskArchiveSweepReceipt,
} from '../application/ports/taskArchiveMaintenanceCommand'

export function createDrizzleTaskArchiveMaintenanceCommand(
  db: ProviderNeutralDatabase,
  input: { readonly content?: TaskArchiveContentPort } = {},
): TaskArchiveMaintenanceCommand {
  return createTaskArchiveContentCoordinator(db, input.content ?? createFileTaskArchiveContent())
}
