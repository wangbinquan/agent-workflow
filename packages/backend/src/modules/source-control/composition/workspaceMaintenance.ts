import type { ProviderNeutralDatabase } from '@/db/query'
import { createWorkspaceMaintenanceCommand } from '../application/workspaceMaintenance'
import type { WorkspaceTerminalMaintenance } from '../application/ports/workspaceMaintenance'
import { createNodeWorkspaceMaintenanceFilesystem } from '../infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { DrizzleWorkspaceMaintenanceStore } from '../infrastructure/workspaceMaintenanceStore'
import type {
  WorkspaceClaimFinalizationCommand,
  WorkspaceMaintenanceCommand,
} from '../public/commands'

interface WorkspaceMaintenanceCompositionInput {
  readonly appHome: string
  readonly terminalMaintenance: WorkspaceTerminalMaintenance
  readonly isMaterializingTask: (taskId: string) => boolean
  readonly invalidateWorkspacePath: (path: string) => void
}

function filesystem(input: WorkspaceMaintenanceCompositionInput) {
  return createNodeWorkspaceMaintenanceFilesystem({
    appHome: input.appHome,
    isMaterializingTask: input.isMaterializingTask,
    invalidateWorkspacePath: input.invalidateWorkspacePath,
  })
}

/** RFC-359 W3-T15-B / W4-B6：一份 store，调用方（boot / 测试）看不见 provider。 */
export function composeWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: ProviderNeutralDatabase },
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return createWorkspaceMaintenanceCommand({
    store: new DrizzleWorkspaceMaintenanceStore(input.db),
    terminalMaintenance: input.terminalMaintenance,
    filesystem: filesystem(input),
  })
}

/** 两个 bootstrap 的具名绑定（RFC-349 起的装配入口名保持稳定）。 */
export function composeSqliteWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: ProviderNeutralDatabase },
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return composeWorkspaceMaintenanceCommand(input)
}

export function composePostgresqlWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: ProviderNeutralDatabase },
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return composeWorkspaceMaintenanceCommand(input)
}
