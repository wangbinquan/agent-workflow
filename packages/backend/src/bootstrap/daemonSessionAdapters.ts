// RFC-391 — all provider differences for the two neutral daemon graphs.
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import {
  requireDatabaseProviderRuntime,
  requireDatabaseConfig,
  type ResolvedDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  DAEMON_TASK_EXECUTION_ADAPTERS,
} from '@/bootstrap/daemonModules/adapters'
import type {
  DaemonProviderCoreAdapters,
  SelectedDaemonProviderCore,
} from '@/bootstrap/daemonModules/providerCore'
import type { DaemonTaskExecutionAdapters } from '@/bootstrap/daemonModules/taskExecution'
import type { DaemonProviderSessionComposeInput } from './daemonSessionInput'
import type { DaemonApplicationInput } from './daemonApplication'
import { DAEMON_GENERATION } from '@/services/daemonGeneration'
import { isDbSnapshotInProgress } from '@/platform/persistence/sqlite/systemProviderBackup'
import { openSqliteMaintenanceAdmissionStore } from '@/platform/persistence/sqlite/maintenanceAdmissionStore'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import type { createMaintenanceService } from '@/platform/background/maintenanceService'
import type { startMaintenanceWorkerSupervisor } from '@/platform/background/maintenanceWorkerSupervisor'
import type { startBackupScheduler } from '@/services/backupScheduler'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import { join } from 'node:path'

type ApplicationProviders = {
  readonly sqlite: Pick<
    Extract<ResolvedDatabaseProviderRuntime, { provider: 'sqlite' }>,
    'provider' | 'telemetry'
  >
  readonly postgresql: Pick<
    Extract<ResolvedDatabaseProviderRuntime, { provider: 'postgresql' }>,
    'provider' | 'runtime' | 'telemetry'
  >
}
export type DaemonApplicationProvider<P extends DatabaseProvider> = ApplicationProviders[P]
type ApplicationDatabases = {
  readonly sqlite: DbClient
  readonly postgresql: PostgresqlDatabaseClient
}
export type DaemonApplicationDatabase<P extends DatabaseProvider> = ApplicationDatabases[P]
type MaintenanceOptions = Parameters<typeof createMaintenanceService>[0]
type BackupOptions = Parameters<typeof startBackupScheduler>[0]
export interface DaemonSessionAdapter<P extends DatabaseProvider = DatabaseProvider> {
  open(
    provider: ResolvedDatabaseProviderRuntime,
    migrationsFolder: string,
  ): DaemonApplicationDatabase<P>
  admitSelections<T extends object>(input: T): T
  core(input: DaemonApplicationInput<P>): DaemonProviderCoreAdapters<P>
  taskExecution(input: DaemonApplicationInput<P>): DaemonTaskExecutionAdapters<P>
  afterCore(core: SelectedDaemonProviderCore<P>): Promise<void>
  maintenance(input: {
    config: Config
    db: DaemonApplicationDatabase<P>
    dbPath: string
    migrationsFolder: string
    generationId: string
  }): Pick<MaintenanceOptions, 'provider' | 'fileSnapshotInFlight' | 'openAdmissionStore'> & {
    readonly databaseInit: (
      current: Config,
    ) => Parameters<typeof startMaintenanceWorkerSupervisor>[0]['databaseInit']
  }
  scheduledBackup(input: {
    core: SelectedDaemonProviderCore<P>
    db: DaemonApplicationDatabase<P>
    databaseBackup?: DatabaseBackupEffects
  }):
    | { readonly db: NonNullable<BackupOptions['db']>; readonly createScheduledBackup?: never }
    | {
        readonly db?: never
        readonly createScheduledBackup: NonNullable<BackupOptions['createScheduledBackup']>
      }
  recoveryProofGeneration(provider: DaemonApplicationProvider<P>): string
}

export const HOSTED_ONLY_SELECTIONS = [
  'credentials',
  'systemAgentRunFamily',
  'workspacePresence',
  'reviewArtifacts',
  'reviewRollbackSnapshots',
  'taskInputFiles',
  'mcpDiagnostics',
  'beforeEventObservationWrite',
  'humanGateArtifactRecovery',
  'runtimeInventoryContent',
  'runtimeManagement',
  'developmentWorkspaceRepositoryPreparation',
  'archivedNodeEvents',
  'crewStationEvents',
  'intentArtifacts',
  'databaseBackup',
  'hostedBackgroundOwners',
  'taskRecovery',
  'repositoryPublicationTransport',
  'programFixtureProcess',
  'actionWorkspaceEntries',
  'repositoryRemote',
  'repositoryRevisionContent',
  'codeReviewArtifacts',
  'fusionWorkspaceEffects',
] as const satisfies readonly (keyof DaemonProviderSessionComposeInput)[]
type HostedOnlySelection = (typeof HOSTED_ONLY_SELECTIONS)[number]
/** Reject hosted selections before opening or composing a standalone session. */
export function standaloneSelectionsOf<T extends object>(input: T): T {
  const selections = input as Partial<Record<HostedOnlySelection, unknown>>
  const hosted = HOSTED_ONLY_SELECTIONS.filter((key) => selections[key] !== undefined)
  if (hosted.length > 0)
    throw new Error(`hosted-deployment-requires-postgresql: ${hosted.join(', ')}`)
  return input
}

export const DAEMON_SESSION_ADAPTERS: {
  readonly [P in DatabaseProvider]: DaemonSessionAdapter<P>
} = {
  sqlite: {
    open: (provider, migrationsFolder) =>
      requireDatabaseProviderRuntime(provider, 'sqlite').openClient({ migrationsFolder }),
    admitSelections: standaloneSelectionsOf,
    core: (input) =>
      DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
        db: input.db,
        appHome: input.appHome,
        dbPath: input.dbPath ?? join(input.appHome, 'db.sqlite'),
        lockPath: input.lockPath,
        secretBox: input.secretBox,
      }),
    taskExecution: (input) => DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db: input.db }),
    afterCore: async () => {},
    maintenance: ({ dbPath, migrationsFolder }) => ({
      provider: 'sqlite',
      fileSnapshotInFlight: isDbSnapshotInProgress,
      openAdmissionStore: (current) =>
        openSqliteMaintenanceAdmissionStore({
          dbPath,
          migrationsFolder,
          synchronous: current.sqliteSynchronous,
          pageCacheMib: current.sqlitePageCacheMib,
          mmapMib: current.sqliteMmapMib,
        }),
      databaseInit: (current) => ({
        dbPath,
        migrationsFolder,
        sqlite: {
          synchronous: current.sqliteSynchronous,
          pageCacheMib: current.sqlitePageCacheMib,
          mmapMib: current.sqliteMmapMib,
          busyTimeoutMs: 50,
        },
      }),
    }),
    scheduledBackup: ({ db }) => ({ db }),
    recoveryProofGeneration: () => DAEMON_GENERATION,
  },
  postgresql: {
    open: (provider) => requireDatabaseProviderRuntime(provider, 'postgresql').openClient(),
    admitSelections: <T extends object>(input: T): T => input,
    core: (input) =>
      DAEMON_PROVIDER_CORE_ADAPTERS.postgresql({
        db: input.db,
        runtime: input.provider.runtime,
        databaseConfig: requireDatabaseConfig(input.config.database, 'postgresql'),
        backup: input.databaseBackup,
        appHome: input.appHome,
        lockPath: input.lockPath,
      }),
    taskExecution: (input) =>
      DAEMON_TASK_EXECUTION_ADAPTERS.postgresql({ db: input.db, runtime: input.provider.runtime }),
    afterCore: async (core) => {
      await core.systemOperations.applyPendingRestore()
    },
    maintenance: ({ config, db, generationId }) => ({
      provider: 'postgresql',
      fileSnapshotInFlight: () => false,
      openAdmissionStore: () => ({ store: createMaintenanceRunStore(db) }),
      databaseInit: () => ({
        provider: 'postgresql',
        generationId,
        database: requireDatabaseConfig(config.database, 'postgresql'),
      }),
    }),
    scheduledBackup: ({ core, databaseBackup }) => ({
      createScheduledBackup: () =>
        databaseBackup
          ? databaseBackup.request({ includeWorktrees: false, kind: 'scheduled' })
          : core.systemOperations.application.commands.requestBackup.execute(
              core.systemOperations.localContext,
              { includeWorktrees: true },
            ),
    }),
    recoveryProofGeneration: (provider) => provider.runtime.generationId,
  },
} satisfies { readonly [P in DatabaseProvider]: DaemonSessionAdapter<P> }
