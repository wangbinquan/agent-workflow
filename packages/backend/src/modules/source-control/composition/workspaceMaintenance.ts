import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createWorkspaceMaintenanceCommand } from '../application/workspaceMaintenance'
import type { WorkspaceTerminalMaintenance } from '../application/ports/workspaceMaintenance'
import { createNodeWorkspaceMaintenanceFilesystem } from '../infrastructure/nodeWorkspaceMaintenanceFilesystem'
import { PostgresqlWorkspaceMaintenanceStore } from '../infrastructure/postgresqlWorkspaceMaintenanceStore'
import { SqliteWorkspaceMaintenanceStore } from '../infrastructure/sqliteWorkspaceMaintenanceStore'
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

export function composeSqliteWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: DbClient },
): WorkspaceMaintenanceCommand {
  return createWorkspaceMaintenanceCommand({
    store: new SqliteWorkspaceMaintenanceStore(input.db),
    terminalMaintenance: input.terminalMaintenance,
    filesystem: filesystem(input),
  })
}

export function composePostgresqlWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: PostgresqlDatabaseClient },
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  return createWorkspaceMaintenanceCommand({
    store: new PostgresqlWorkspaceMaintenanceStore(input.db),
    terminalMaintenance: input.terminalMaintenance,
    filesystem: filesystem(input),
  })
}
