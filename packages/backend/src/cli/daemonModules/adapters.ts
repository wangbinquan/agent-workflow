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
