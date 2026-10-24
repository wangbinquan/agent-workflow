import type { WorkspaceGcTaskPort, TaskWorkspacePruneParticipant } from './required-ports'
import { createWorkspaceMaintenanceCommand } from '../application/workspaceMaintenance'
import type {
  WorkspaceMaintenanceFilesystem,
  WorkspaceTerminalMaintenance,
} from '../application/ports/workspaceMaintenance'
import { createNodeWorkspaceMaintenanceFilesystem } from '../infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { PortWorkspaceMaintenanceStore } from '../infrastructure/workspaceMaintenanceStore'
import type {
  WorkspaceClaimFinalizationCommand,
  WorkspaceMaintenanceCommand,
} from '../public/commands'

interface WorkspaceMaintenanceCompositionInput {
  readonly workspaceGc: WorkspaceGcTaskPort
  readonly workspacePrune: TaskWorkspacePruneParticipant
  readonly appHome: string
  readonly terminalMaintenance: WorkspaceTerminalMaintenance
  readonly isMaterializingTask: (taskId: string) => boolean
  readonly invalidateWorkspacePath: (path: string) => void
  /** Selected workspace effects are shared by GC, recovery and finalization. */
  readonly filesystem?: WorkspaceMaintenanceFilesystem
}

function filesystem(input: WorkspaceMaintenanceCompositionInput) {
  return (
    input.filesystem ??
    createNodeWorkspaceMaintenanceFilesystem({
      appHome: input.appHome,
      isMaterializingTask: input.isMaterializingTask,
      invalidateWorkspacePath: input.invalidateWorkspacePath,
    })
  )
}

/** RFC-359 W3-T15-B / W4-B6：一份 store，调用方（boot / 测试）看不见 provider。 */
export function composeWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput,
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return createWorkspaceMaintenanceCommand({
    store: new PortWorkspaceMaintenanceStore(input),
    terminalMaintenance: input.terminalMaintenance,
    filesystem: filesystem(input),
  })
}
