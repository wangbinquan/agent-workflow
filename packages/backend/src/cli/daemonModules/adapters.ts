import { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition'
import {
  composePostgresqlSystemOperations,
  composeSystemOperations,
} from '@/modules/system-operations/composition'
import {
  composePostgresqlMaintenanceDiskOperations,
  composeSqliteMaintenanceDiskOperations,
} from '@/modules/system-operations/composition/maintenanceDisk'
import { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { DaemonProviderCoreAdapters } from './providerCore'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import {
  composeProcessTaskExecutionBinding,
  composeSessionTaskExecutionBinding,
} from '@/modules/task-execution/composition/taskExecutionBinding'
import type { DaemonTaskExecutionAdapters } from './taskExecution'

type CoreAdapterInput = {
  readonly sqlite: Omit<
    Parameters<typeof composeSystemOperations>[0],
    'repositoryBackupPreparation'
  > & { readonly appHome: string }
  readonly postgresql: Omit<
    Parameters<typeof composePostgresqlSystemOperations>[0],
    'repositoryBackupPreparation'
  > & { readonly appHome: string }
}

/** Provider-specific effects are selected by this exhaustive table only. */
export const DAEMON_PROVIDER_CORE_ADAPTERS = {
  sqlite: (input) => ({
    provider: 'sqlite',
    systemOperations: (repositoryBackupPreparation) =>
      composeSystemOperations({ ...input, repositoryBackupPreparation }),
    maintenanceDisk: () => composeSqliteMaintenanceDiskOperations(input.db, input.appHome),
  }),
  postgresql: (input) => ({
    provider: 'postgresql',
    systemOperations: (repositoryBackupPreparation) =>
      composePostgresqlSystemOperations({ ...input, repositoryBackupPreparation }),
    maintenanceDisk: () => composePostgresqlMaintenanceDiskOperations(input.runtime, input.appHome),
  }),
} satisfies {
  readonly [P in DatabaseProvider]: (input: CoreAdapterInput[P]) => DaemonProviderCoreAdapters<P>
}

export function standaloneModuleAdapters() {
  return Object.freeze({
    systemAgentRunFamily: composeLocalSystemAgentRunFamily,
    mcpDiagnostics: composeLocalMcpDiagnostics,
    runtimeManagement: composeLocalRuntimeManagement,
    workspacePresence: createFileWorkspacePresenceQueries,
  })
}
export type DaemonModuleAdapters = ReturnType<typeof standaloneModuleAdapters>

type TaskAdapterInput = {
  readonly sqlite: { readonly db: DbClient }
  readonly postgresql: {
    readonly db: PostgresqlDatabaseClient
    readonly runtime: object
  }
}

/** RFC-388: deployment binding and the unchanged configuration hot-apply key. */
export const DAEMON_TASK_EXECUTION_ADAPTERS = {
  sqlite: ({ db }) => ({
    provider: 'sqlite',
    execution: () => composeProcessTaskExecutionBinding(db),
    processConcurrencyScope: db,
  }),
  postgresql: ({ runtime }) => ({
    provider: 'postgresql',
    execution: (persistence) =>
      composeSessionTaskExecutionBinding({ daemonGeneration: DAEMON_GENERATION, persistence }),
    processConcurrencyScope: runtime,
  }),
} satisfies {
  readonly [P in DatabaseProvider]: (input: TaskAdapterInput[P]) => DaemonTaskExecutionAdapters<P>
}
