// RFC-393: type-only contracts shared by the daemon startup sequence and session graph.
import type { DeploymentSelections } from './deploymentProfile'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type {
  WorkspaceUploadContentFactory,
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import type { ApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { SecretBox } from '@/auth/secretBox'
import type { loadConfig } from '@/config'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import type { DaemonStartupLease } from '@/modules/system-operations/composition'
import type { createLogger } from '@/util/log'
import type { ResolvedDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import type { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { DaemonProviderListenerRuntimeSession } from './daemonProviderRuntimeRouter'
import type { DaemonProviderSessionLifecycleInput } from './daemonProviderSession'
import type { RuntimeLegacyConfigurationPort } from '@/modules/runtime-management/composition/runtimeRegistry'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import type { RepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'

type DatabaseMigrationAdmission = Parameters<typeof composeDatabaseMigrationModule>[0]['admission']

/** RFC-359 W3-T16：两个 provider 的会话装配器共用的输入——`startCommand` 只准备这一份。 */
export interface DaemonProviderSessionComposeInput extends DeploymentSelections {
  readonly requiredProvider: DatabaseProvider | null
  readonly provider: ResolvedDatabaseProviderRuntime
  readonly lifecycle: DaemonProviderSessionLifecycleInput
  readonly config: ReturnType<typeof loadConfig>
  readonly configuration: ApplicationConfigurationQueries
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly runtimeLegacyConfiguration: RuntimeLegacyConfigurationPort
  readonly workspaceUploads: WorkspaceUploadContentFactory
  readonly isolationWorkspaces: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces: RepositoryGitWorkspaceFactory
  readonly workspaceReads: RepositoryWorkspaceReadQueries
  readonly daemonRuntime: DaemonRuntimeQueries
  readonly token: string
  readonly secretBox: SecretBox
  /** Reported when a background handle fails to start on activation. */
  readonly onExecutionActivationFailure?: (error: unknown) => void
  readonly dbVersion: number
  readonly migrationAdmission: DatabaseMigrationAdmission
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly log: ReturnType<typeof createLogger>
  readonly lock: DaemonStartupLease
  readonly migrationsFolder: string
  readonly digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject'
}

export interface ComposedDaemonProviderSession {
  readonly application: {
    readonly core: {
      readonly authRuntime: Pick<AuthRuntime, 'isBootstrapRequired'>
    }
  }
  readonly session: DaemonProviderListenerRuntimeSession
}
