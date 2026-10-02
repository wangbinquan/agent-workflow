// RFC-370: select archive content at composition; both providers share the original coordinator.
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskArchiveContentPort } from '../application/ports/taskArchiveContent'
import type {
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
} from '../application/ports/taskArchiveMaintenanceCommand'
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

/** A selected store and its logical roots travel together through every archive consumer. */
export interface TaskArchiveContentBinding {
  readonly content: TaskArchiveContentPort
  readonly locations: Readonly<
    Pick<TaskArchiveMaintenanceOptions, 'archiveDir' | 'runsDir' | 'logsDir'>
  >
}

export function createDrizzleTaskArchiveMaintenanceCommand(
  db: ProviderNeutralDatabase,
  input: {
    readonly content?: TaskArchiveContentPort
    readonly locations?: TaskArchiveContentBinding['locations']
  } = {},
): TaskArchiveMaintenanceCommand {
  const command = createTaskArchiveContentCoordinator(
    db,
    input.content ?? createFileTaskArchiveContent(),
  )
  if (input.locations === undefined) return command
  // Freeze the selected roots once. Request timestamps and archive policy remain caller-owned.
  const locations = Object.freeze({
    archiveDir: input.locations.archiveDir,
    runsDir: input.locations.runsDir,
    logsDir: input.locations.logsDir,
  })
  return Object.freeze<TaskArchiveMaintenanceCommand>({
    runSweep(config, options) {
      return command.runSweep(config, { ...options, ...locations })
    },
    preview(request) {
      return command.preview(request)
    },
    runManual(request, options) {
      return command.runManual(request, { ...options, ...locations })
    },
    recover(options) {
      return command.recover({ ...options, ...locations })
    },
  })
}
