import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WorkspaceMaintenanceCommand } from '@/modules/source-control/public/commands'
import type { TaskRepositoryPreparationBinding } from '../infrastructure/repositoryPreparationBinding'
import {
  createWorkerWorkspaceMaintenance,
  createWorkspacePreparationMaintenance,
} from '../infrastructure/workspacePreparationGc'

/** Runs inside the existing workspace orphan job. It never schedules new work. RFC-423: the phase routing is
 * infrastructure/workspacePreparationGc.ts; the maintenance worker graph keeps calling this name. */
export function composeWorkspacePreparationMaintenance(input: {
  db: PersistenceDb
  appHome: string
  repositoryPreparation: TaskRepositoryPreparationBinding
  maintenance: WorkspaceMaintenanceCommand
}): WorkspaceMaintenanceCommand {
  return createWorkspacePreparationMaintenance(input)
}

/** Worker payload supplies the active materialization snapshot for each GC phase (RFC-423: infrastructure). */
export function createWorkerWorkspaceMaintenanceCommand(
  factory: (isMaterializingTask: (taskId: string) => boolean) => WorkspaceMaintenanceCommand,
): WorkspaceMaintenanceCommand {
  return createWorkerWorkspaceMaintenance(factory)
}
