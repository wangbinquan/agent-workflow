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
import { SYSTEM_USER_ID } from '@/auth/actor'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import {
  retryRepositoryPreparation,
  composeWorkgroupTaskRoomContinuationDriver,
} from '@/services/task'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import {
  createProviderTaskExecutionModule,
  taskExecutionModule,
} from '@/modules/task-execution/composition'
import { createTaskDriverLifecyclePort } from '@/modules/task-execution/composition/taskDriveLegacy'
import {
  composeSqliteTaskExecutionProviderRuntime,
  composePostgresqlTaskExecutionProviderRuntime,
} from '@/modules/task-execution/composition/providerRuntime'
import { composeWorktreeResumePreflight } from '@/modules/task-execution/public/participants'
import { createLogger } from '@/util/log'
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

/** RFC-382: the remaining execution/claim, scope, fusion, retry and room differences live here. */
export const DAEMON_TASK_EXECUTION_ADAPTERS = {
  sqlite: ({ db }) => ({
    provider: 'sqlite',
    compose(input) {
      const persistence = input.persistence
      const driverLifecycle = createTaskDriverLifecyclePort({
        db,
        persistence,
        module: taskExecutionModule,
        legacyConnection: db,
        claim: (intentId) => taskExecutionModule.claim({ db, intentId }),
        log: createLogger('task'),
        finalizeWorkspace: input.finalizeWorkspace,
      })
      const provider = composeSqliteTaskExecutionProviderRuntime(db, {
        ...input,
        driverLifecycle,
        routeLaunch: { ...input.routeLaunch, routeWorkspace: input.routeWorkspace },
        repositoryPreparationRetry: Object.freeze({
          // RFC-385 owns this per-call path. Keep its actor and local/selected semantics.
          async retry(taskId: string, authorization?: { readonly actorUserId: string }) {
            const configuration = input.legacyLaunch.configuration
            const configPath = input.routeLaunch.configPath
            const launchRuntime =
              configuration.selectedQueries === undefined
                ? resolveLaunchRuntimeConfig(configPath)
                : {}
            const retryDeps = {
              ...(configuration.selectedQueries === undefined
                ? buildStartTaskDeps(
                    db,
                    provider.runtime.schedulerDriver,
                    configPath,
                    authorization?.actorUserId ?? SYSTEM_USER_ID,
                    input.routeWorkspace.secretBox,
                    input.legacyLaunch.identityAccess,
                    {
                      repositoryWorkspace: input.legacyLaunch.repositoryWorkspace,
                      runtimeSessionLeases: input.runtime.runtimeSessionLeases,
                    },
                  )
                : {
                    db,
                    schedulerDriver: provider.runtime.schedulerDriver,
                    configPath,
                    repositoryWorkspace: input.legacyLaunch.repositoryWorkspace,
                    runtimeSessionLeases: input.runtime.runtimeSessionLeases,
                    actorUserId: authorization?.actorUserId ?? SYSTEM_USER_ID,
                    secretBox: input.routeWorkspace.secretBox,
                    identityAccess: input.legacyLaunch.identityAccess,
                    launchConfiguration: configuration.selectedQueries,
                    ...(await configuration.start()),
                  }),
              agentLaunchResources: input.legacyLaunch.agentLaunchResources,
              repositoryPreparation: composeRepositoryPreparation({
                db,
                appHome: input.routeWorkspace.appHome,
                secretBox: input.routeWorkspace.secretBox,
                cloneTimeoutMs: launchRuntime.cloneTimeoutMs,
                ...(configuration.preparationConfiguration === undefined
                  ? {}
                  : { preparationConfiguration: configuration.preparationConfiguration }),
                ...input.legacyLaunch.preparationEffects,
              }),
            }
            await retryRepositoryPreparation(db, taskId, retryDeps)
          },
        }),
      })
      return provider
    },
    roomContinuation({ provider, configPath, configuration, workspacePresence }) {
      return composeWorkgroupTaskRoomContinuationDriver({
        db,
        configPath,
        workspacePresence,
        schedulerDriver: provider.runtime.schedulerDriver,
        taskRecoveryOperations: provider.recovery,
        ...(configuration.selectedQueries === undefined
          ? {}
          : { launchConfiguration: configuration.selectedQueries }),
      })
    },
  }),
  postgresql: ({ db, runtime }) => ({
    provider: 'postgresql',
    compose(input) {
      const persistence = input.persistence
      const executionModule = createProviderTaskExecutionModule({
        daemonGeneration: DAEMON_GENERATION,
        persistence,
      })
      const log = createLogger('task')
      const driverLifecycle = createTaskDriverLifecyclePort({
        db,
        persistence,
        module: executionModule,
        claim: (intentId) => executionModule.claimPersisted({ intentId }),
        log,
        finalizeWorkspace: input.finalizeWorkspace,
      })
      return composePostgresqlTaskExecutionProviderRuntime(db, {
        ...input,
        driverLifecycle,
        runtime: {
          ...input.runtime,
          persistence,
          executionModule,
          processConcurrencyScope: runtime,
          daemonGeneration: DAEMON_GENERATION,
          finalizeWorkspace: input.finalizeWorkspace,
          log,
        },
        workgroupTaskRoom: input.workgroupTaskRoom,
      })
    },
    roomContinuation({ provider, workspacePresence }) {
      return Object.freeze({
        assertResumable: composeWorktreeResumePreflight({
          getTask: provider.routes.tasks.get,
          taskRecoveryOperations: provider.recovery,
          worktreeExists: (reference) => workspacePresence.exists(reference),
        }),
        // RFC-385: the PostgreSQL worker still owns drive-after-commit.
        driveAfterCommit: async () => {},
      })
    },
  }),
} satisfies {
  readonly [P in DatabaseProvider]: (input: TaskAdapterInput[P]) => DaemonTaskExecutionAdapters<P>
}
