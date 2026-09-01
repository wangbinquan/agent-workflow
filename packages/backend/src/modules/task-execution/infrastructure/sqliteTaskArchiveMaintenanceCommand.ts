import type { DbClient } from '@/db/client'
import {
  previewArchivableTrees,
  runManualTaskArchive,
  runTaskArchiveSweep,
} from '@/services/taskArchive'
import type {
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
} from '../application/ports/taskArchiveMaintenanceCommand'

export function createSqliteTaskArchiveMaintenanceCommand(
  db: DbClient,
): TaskArchiveMaintenanceCommand {
  return Object.freeze({
    async runSweep(config: TaskArchiveConfig, options: TaskArchiveMaintenanceOptions) {
      return await runTaskArchiveSweep(db, config, options)
    },
    async preview(input: Parameters<TaskArchiveMaintenanceCommand['preview']>[0]) {
      return await previewArchivableTrees(db, input.retentionDays, input.maxTrees, input.now)
    },
    async runManual(
      input: Parameters<TaskArchiveMaintenanceCommand['runManual']>[0],
      options: Parameters<TaskArchiveMaintenanceCommand['runManual']>[1],
    ) {
      return await runManualTaskArchive(
        db,
        {
          retentionDays: input.retentionDays,
          maxTrees: input.maxTrees,
          actorUserId: input.actorUserId,
        },
        { ...options, ...(input.now === undefined ? {} : { now: input.now }) },
      )
    },
  })
}
