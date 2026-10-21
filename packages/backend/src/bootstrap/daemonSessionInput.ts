// RFC-393: type-only contracts shared by the daemon startup sequence and session graph.
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { HumanGateArtifactRecovery } from '@/modules/collaboration/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type { DevelopmentPurposeSelection } from '@/modules/development-automation/composition'
import type { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import type { TaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type {
  WorkspaceUploadContentFactory,
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
import type {
  PortArtifactContentEffects,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import type {
  NodeRunPromptContentEffects,
  TaskDeletionEffects,
} from '@/modules/task-execution/public/types'
import type {
  ActionWorkspaceEffects,
  AutomationWorkspaceEffectsFactory,
} from '@/modules/development-automation/composition'
import type { ConflictMergeWorkspaceEffects } from '@/modules/source-control/public/types'
import type {
  RepositoryBaselineEffectsFactory,
  VerificationCommandEffectsFactory,
} from '@/modules/development-automation/composition'
import type { ApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { SecretBox } from '@/auth/secretBox'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import type { loadConfig } from '@/config'
import type {
  EvidenceDocumentCommands,
  EvidenceArtifactPort,
  AttemptContextStorePort,
} from '@/modules/development-automation/composition'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import type { BootExecutionRecoveryFactory } from '@/modules/task-execution/composition/bootRecovery'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import type { DaemonStartupLease } from '@/modules/system-operations/composition'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import type { createLogger } from '@/util/log'
import type { CustomObserverProgramFactory } from '@/modules/event-center/composition'
import type { ResolvedDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import type { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { DaemonProviderListenerRuntimeSession } from './daemonProviderRuntimeRouter'
import type { DaemonProviderSessionLifecycleInput } from './daemonProviderSession'
import type { SignalledDaemonRuntimeOwner } from './daemonProviderRuntimeHandles'
import type { MaintenanceWorkerEffectsDescriptor } from '@/platform/background/maintenanceWorkerEffects'
import type {
  EmployeeCaseWorkspaceEffectsFactory,
  RepositoryRemoteEffects,
  WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import type {
  ResourcePackageSkillArtifactOwner,
  ResourcePackagePluginArtifactOwner,
  SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { RuntimeLegacyConfigurationPort } from '@/modules/runtime-management/composition/runtimeRegistry'
import type { MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import type { SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { ScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionRunners'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import type { RepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'

type DatabaseMigrationAdmission = Parameters<typeof composeDatabaseMigrationModule>[0]['admission']

/** RFC-359 W3-T16：两个 provider 的会话装配器共用的输入——`startCommand` 只准备这一份。 */
export interface DaemonProviderSessionComposeInput {
  readonly provider: ResolvedDatabaseProviderRuntime
  readonly lifecycle: DaemonProviderSessionLifecycleInput
  readonly config: ReturnType<typeof loadConfig>
  readonly configuration: ApplicationConfigurationQueries
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly runtimeLegacyConfiguration: RuntimeLegacyConfigurationPort
  readonly taskArchive?: TaskArchiveContentBinding
  readonly skillContent?: SkillContentBinding
  readonly employeePrograms?: ProgramArtifactPort
  readonly programFixtureProcess?: ScriptFixtureProcess
  readonly actionWorkspaceEntries?: ActionWorkspaceEntries
  readonly repositoryRevisionContent?: RepositoryRevisionContentFactory
  readonly codeReviewArtifacts?: CodeReviewArtifactStore
  readonly employeeInputArtifacts?: EmployeeInputArtifactPort
  readonly missionInputBlobs?: MissionInputBlobPersistence
  readonly pluginInstaller?: PluginInstallerPort
  readonly beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  readonly humanGateArtifactRecovery?: HumanGateArtifactRecovery
  readonly databaseBackup?: DatabaseBackupEffects
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly intentArtifacts?: IntentArtifactSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly resourcePackageSkillContent?: SkillPackageContentReader
  readonly workspaceContent?: WorkspaceContentEffectsFactory
  readonly repositoryRemote?: RepositoryRemoteEffects
  readonly workspaceUploads: WorkspaceUploadContentFactory
  readonly isolationWorkspaces: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces: RepositoryGitWorkspaceFactory
  readonly repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  readonly workspaceReads: RepositoryWorkspaceReadQueries
  readonly employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly verificationCommands?: VerificationCommandEffectsFactory
  readonly customObserverPrograms?: CustomObserverProgramFactory
  readonly bootExecutionRecovery?: BootExecutionRecoveryFactory
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  readonly taskDeletionEffects?: TaskDeletionEffects
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  readonly nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  readonly taskRunSelection?: TaskRunRootSelection
  readonly taskRecovery?: TaskRecoveryDeploymentSelection
  readonly taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  readonly hostedBackgroundOwners?: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly systemAgentRunFamily?: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics?: typeof composeLocalMcpDiagnostics
  readonly developmentPurposes?: DevelopmentPurposeSelection
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  readonly workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  readonly maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  readonly evidenceRead?: EvidenceReadBinding
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly attemptContext?: AttemptContextStorePort
  readonly daemonRuntime: DaemonRuntimeQueries
  readonly token: string
  readonly secretBox: SecretBox
  readonly executionAuthority?: ExecutionAuthorityPort
  readonly credentials?: CredentialAdapterSelection
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

export type DaemonProviderSessionComposer = (
  input: DaemonProviderSessionComposeInput,
) => Promise<ComposedDaemonProviderSession>
