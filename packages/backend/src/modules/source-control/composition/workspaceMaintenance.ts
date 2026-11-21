import type { WorkspaceGcTaskPort, TaskWorkspacePruneParticipant } from './required-ports'
import { createWorkspaceMaintenanceCommand } from '../application/workspaceMaintenance'
import type {
  WorkspaceMaintenanceFilesystem,
  WorkspaceTerminalMaintenance,
} from '../application/ports/workspaceMaintenance'
import { PortWorkspaceMaintenanceStore } from '../infrastructure/workspaceMaintenanceStore'
import type {
  WorkspaceClaimFinalizationCommand,
  WorkspaceMaintenanceCommand,
} from '../public/commands'

interface WorkspaceMaintenanceCompositionInput {
  readonly workspaceGc: WorkspaceGcTaskPort
  readonly workspacePrune: TaskWorkspacePruneParticipant
  readonly terminalMaintenance: WorkspaceTerminalMaintenance
  /**
   * Selected workspace effects are shared by GC, recovery and finalization. RFC-527: required (standalone: the local
   * filesystem, which carries the app home, the materializing check and the path invalidation itself).
   */
  readonly filesystem: WorkspaceMaintenanceFilesystem
}

/** RFC-359 W3-T15-B / W4-B6：一份 store，调用方（boot / 测试）看不见 provider。 */
export function composeWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput,
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return createWorkspaceMaintenanceCommand({
    store: new PortWorkspaceMaintenanceStore(input),
    terminalMaintenance: input.terminalMaintenance,
    filesystem: input.filesystem,
  })
}
