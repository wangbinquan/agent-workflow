import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import {
  previewArchivableTrees,
  recoverInterruptedArchives,
  runManualTaskArchive,
  runTaskArchiveSweep,
} from '@/services/taskArchive'
import { createLogger } from '@/util/log'
import type {
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
  TaskArchiveRecoveryReceipt,
} from '../application/ports/taskArchiveMaintenanceCommand'
import { sweepArchiveTempDirectories } from './archiveTempDirectorySweep'

const log = createLogger('task-archive')

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
    // RFC-359 W3-T15-B：先续做 RFC-328 认领（legacy 实现），再按与 PostgreSQL 同一份规则收尾 `.tmp-*`。
    async recover(options: TaskArchiveMaintenanceOptions): Promise<TaskArchiveRecoveryReceipt> {
      const claims = await recoverInterruptedArchives(db, options)
      const swept = await sweepArchiveTempDirectories({
        archiveRoot: options.archiveDir,
        runsDir: options.runsDir,
        logsDir: options.logsDir,
        claimedRoots: claims.claimedRoots,
        taskExists: async (taskId) =>
          (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get()) !==
          undefined,
      })
      const promoted = [...claims.promoted, ...swept.promoted]
      const discarded = [...claims.discarded, ...swept.discarded]
      if (promoted.length > 0 || discarded.length > 0) {
        log.info('recovered interrupted archives', { promoted, discarded })
      }
      return { promoted, discarded }
    },
  })
}
