import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'
import type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
import { runWorkspacePreparationGcPhase } from '../infrastructure/workspacePreparationGc'

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
      // RFC-414: the preparation scan and compensation are infrastructure.
      return runWorkspacePreparationGcPhase(input, { ...request, phase: request.phase })
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
