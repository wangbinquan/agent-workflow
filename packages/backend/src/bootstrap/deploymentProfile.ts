import type { HistoryRestrictionPort as ImportedHistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { ContentStore as ImportedContentStore } from '@/platform/content/contentStore'
// RFC-394: deployment contracts are declared once, independently of the startup sequence.
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { HumanGateArtifactRecovery } from '@/modules/collaboration/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
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
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { SecretBox } from '@/auth/secretBox'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import type {
  EvidenceDocumentCommands,
  EvidenceArtifactPort,
  AttemptContextStorePort,
} from '@/modules/development-automation/composition'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import type { BootExecutionRecoveryFactory } from '@/modules/task-execution/composition/bootRecovery'
import type {
  DaemonStartupLeasePort,
  DaemonDatabasePreOpenRecoveryPort,
} from '@/modules/system-operations/composition'
import type { DaemonDatabaseInstallationPort } from '@/modules/system-operations/composition/daemonDatabase'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import type { createLogger } from '@/util/log'
import type { CustomObserverProgramFactory } from '@/modules/event-center/composition'
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
import type { RepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'
import type { Config } from '@agent-workflow/shared'

export type DeploymentKind = 'standalone' | 'crewstation'

export interface HostProbeInput {
  readonly log: ReturnType<typeof createLogger>
  readonly config: Config
}

export interface DeploymentProfile {
  readonly kind: DeploymentKind
  readonly requiredProvider: DatabaseProvider | null
  readonly probeHost: (input: HostProbeInput) => Promise<string | null>
  readonly listen: { readonly host?: string; readonly port?: number }
  readonly selections: DeploymentSelections
}

export interface DeploymentSelections {
  readonly historyRestrictions?: ImportedHistoryRestrictionPort
  readonly contentStore?: ImportedContentStore

  applicationConfiguration?: ApplicationConfigurationBinding
  databasePreOpenRecovery?: DaemonDatabasePreOpenRecoveryPort
  databaseInstallation?: DaemonDatabaseInstallationPort
  taskArchive?: TaskArchiveContentBinding
  skillContent?: SkillContentBinding
  employeePrograms?: ProgramArtifactPort
  /** RFC-370 §10 V19: where a program tool's contract fixture runs (hosted only). */
  programFixtureProcess?: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below a hosted action workspace (hosted only). */
  actionWorkspaceEntries?: ActionWorkspaceEntries
  /** RFC-370 §10 V16: code-review reads of hosted task volumes (hosted only). */
  repositoryRevisionContent?: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: code-review artifacts as object publications (hosted only). */
  codeReviewArtifacts?: CodeReviewArtifactStore
  employeeInputArtifacts?: EmployeeInputArtifactPort
  missionInputBlobs?: MissionInputBlobPersistence
  pluginInstaller?: PluginInstallerPort
  beforeEventObservationWrite?: (tx: PersistenceDb) => Promise<void>
  humanGateArtifactRecovery?: HumanGateArtifactRecovery
  databaseBackup?: DatabaseBackupEffects
  archivedNodeEvents?: TaskArchivedEventsReader
  crewStationEvents?: CrewStationEventIngress
  intentArtifacts?: IntentArtifactSelection
  evidenceArtifacts?: EvidenceArtifactPort
  resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  resourcePackageSkillContent?: SkillPackageContentReader
  workspaceContent?: WorkspaceContentEffectsFactory
  /** RFC-370 §10 V17: hosted repository remote reads; absent, local mirrors. */
  repositoryRemote?: RepositoryRemoteEffects
  workspaceUploads?: WorkspaceUploadContentFactory
  isolationWorkspaces?: IsolationWorkspaceFactory
  repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  workspaceReads?: RepositoryWorkspaceReadQueries
  employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  repositoryBaselines?: RepositoryBaselineEffectsFactory
  verificationCommands?: VerificationCommandEffectsFactory
  customObserverPrograms?: CustomObserverProgramFactory
  bootExecutionRecovery?: BootExecutionRecoveryFactory
  automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  actionWorkspaceEffects?: ActionWorkspaceEffects
  conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  taskDeletionEffects?: TaskDeletionEffects
  /** RFC-370 §9.2 V3 — hosted only: publication network Git in the task volume. */
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  taskRunSelection?: TaskRunRootSelection
  taskRecovery?: TaskRecoveryDeploymentSelection
  taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  /** RFC-370 §9.2 V1 — deployment workers started with execution authority. */
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
  workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  evidenceRead?: EvidenceReadBinding
  evidenceDocumentCommands?: EvidenceDocumentCommands
  attemptContext?: AttemptContextStorePort
  startupLease?: DaemonStartupLeasePort
  /** RFC-370 v2 H7 — the deployment's execution authority; standalone is always active. */
  executionAuthority?: ExecutionAuthorityPort
  /** RFC-370 v2 §3.6 — the deployment's credential mechanism; standalone sessions by default. */
  credentials?: CredentialAdapterSelection
  /** RFC-370 M0 — a platform-provided master key instead of the local secret.key file. */
  secretBox?: SecretBox
}
