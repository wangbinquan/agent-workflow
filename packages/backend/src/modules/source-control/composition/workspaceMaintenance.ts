import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
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
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
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

/** RFC-359 W3-T15-B：按客户端品牌选 store；调用方（boot / 测试）看不见 provider。 */
export function composeWorkspaceMaintenanceCommand(
  input: WorkspaceMaintenanceCompositionInput & { readonly db: ProviderNeutralDatabase },
): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  const provider = databaseSessionFor(input.db).engine.provider
  return provider === 'postgresql'
    ? composePostgresqlWorkspaceMaintenanceCommand({
        ...input,
        db: input.db as unknown as PostgresqlDatabaseClient,
      })
    : provider === 'sqlite'
      ? composeSqliteWorkspaceMaintenanceCommand({ ...input, db: input.db as unknown as DbClient })
      : unhandledDatabaseProvider(provider)
}
