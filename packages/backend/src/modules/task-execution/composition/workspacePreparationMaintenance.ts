import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  compensateScratchWorkspace,
  scratchAdmissionPrefix,
} from '../infrastructure/scratchWorkspacePreparation'
import { and, eq, isNull } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'
import type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
import {
  compensatePreMaterializedRepository,
  preMaterializedAdmissionPrefix,
} from '../infrastructure/preMaterializedRepositoryWorkspace'
import { createLogger } from '@/util/log'

const log = createLogger('workspace-preparation-maintenance')
const MIN_AGE_MS = 24 * 60 * 60 * 1000

/** Runs inside the existing workspace orphan job. It never schedules new work. */
export function composeWorkspacePreparationMaintenance(input: {
  db: PersistenceDb
  appHome: string
  repositoryPreparation: TaskRepositoryPreparationBinding
  maintenance: WorkspaceMaintenanceCommand
}): WorkspaceMaintenanceCommand {
  return Object.freeze<WorkspaceMaintenanceCommand>({
    ...input.maintenance,
    async runGcPhase(request: Parameters<WorkspaceMaintenanceCommand['runGcPhase']>[0]) {
      if (request.phase !== 'orphan' && request.phase !== 'scratch')
        return input.maintenance.runGcPhase(request)
      const scratch = request.phase === 'scratch'
      const prefix = scratch
        ? scratchAdmissionPrefix(input.appHome)
        : preMaterializedAdmissionPrefix(input.appHome)
      const { taskWorkspacePreparations } = tablesOf(input.db)
      const plans = (
        await input.db
          .select()
          .from(taskWorkspacePreparations)
          .where(
            and(
              eq(taskWorkspacePreparations.lane, 'pre-materialized'),
              isNull(taskWorkspacePreparations.admittedTaskId),
            ),
          )
      ).filter((row) => row.admissionKey.startsWith(prefix) && row.state !== 'cleaned')
      const active = new Set(request.activeTaskIds)
      const now = request.now ?? Date.now()
      let removed = 0
      for (const plan of plans) {
        if (active.has(plan.id) || now - plan.createdAt < MIN_AGE_MS) continue
        try {
          const result = await (
            scratch ? compensateScratchWorkspace : compensatePreMaterializedRepository
          )({
            db: input.db,
            binding: input.repositoryPreparation,
            taskId: plan.id,
          })
          if (result.complete) removed += 1
        } catch (error) {
          log.warn('workspace preparation compensation deferred', {
            taskId: plan.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // A partial cleanup must never fall through to generic rm: SC owns its
      // worktree identity and expected-old branch restoration evidence.
      const receipt = await input.maintenance.runGcPhase({
        ...request,
        activeTaskIds: [...new Set([...request.activeTaskIds, ...plans.map((plan) => plan.id)])],
      })
      return {
        scanned: receipt.scanned + plans.length,
        removed: receipt.removed + removed,
        skipped: receipt.skipped + plans.length - removed,
      }
    },
  })
}

/** Worker payload supplies the active materialization snapshot for each GC phase. */
export function createWorkerWorkspaceMaintenanceCommand(
  factory: (isMaterializingTask: (taskId: string) => boolean) => WorkspaceMaintenanceCommand,
): WorkspaceMaintenanceCommand {
  let protectedTaskIds = new Set<string>()
  const command = factory((taskId) => protectedTaskIds.has(taskId))
  return Object.freeze({
    async runGcPhase(input: Parameters<WorkspaceMaintenanceCommand['runGcPhase']>[0]) {
      protectedTaskIds = new Set(input.activeTaskIds)
      try {
        return await command.runGcPhase(input)
      } finally {
        protectedTaskIds.clear()
      }
    },
    recover: (input: Parameters<WorkspaceMaintenanceCommand['recover']>[0]) =>
      command.recover(input),
  })
}
