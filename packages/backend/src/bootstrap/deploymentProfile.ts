import type { ContentStore as ImportedContentStore } from '@/platform/content/contentStore'
// RFC-394: deployment contracts are declared once, independently of the startup sequence.
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { PostgresqlBackupCoordinatorFactory } from '@/modules/system-operations/composition'
import type { HumanGateArtifactRecovery } from '@/modules/collaboration/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { createRepositoryPublicationTransport } from '@/modules/source-control/composition'
import type {
  composeLocalRepositoryPreparationEffects,
  composeLocalScratchWorkspaceEffects,
} from '@/modules/source-control/composition/repositoryPreparation'
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
  TaskDeletionEffects,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import type { ActionWorkspaceEffects } from '@/modules/development-automation/composition'
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
import type { EvidenceArtifactPort } from '@/modules/development-automation/composition'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/modules/source-control/composition'
import type { BootExecutionRecoveryFactory } from '@/modules/task-execution/composition/bootRecovery'
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
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import type { SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { ScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionEnvironment'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import type { RepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'
import type { Config } from '@agent-workflow/shared'

export type DeploymentKind = 'standalone' | 'crewstation'

export interface HostProbeInput {
  readonly log: ReturnType<typeof createLogger>
  readonly config: Config
}

export interface DeploymentProfile {
  readonly kind: DeploymentKind
  /** RFC-425: the deployment marker the embedded SPA reads before routing; null serves the page unchanged. */
  readonly frontendMarker: string | null
  readonly requiredProvider: DatabaseProvider | null
  readonly probeHost: (input: HostProbeInput) => Promise<string | null>
  readonly listen: { readonly host?: string; readonly port?: number }
  readonly selections: DeploymentSelections
}

/**
 * RFC-427: the selected deployment. Its kind is read once, its start profile is composed on demand (a hosted profile
 * verifies the database first), and the deployment-level commands are its operations.
 */
export interface Deployment {
  readonly kind: DeploymentKind
  profile(): Promise<DeploymentProfile>
  /** `agent-workflow migrate`. */
  migrate(): Promise<{ readonly output: string }>
  /** `agent-workflow verify-database-restore`. */
  verifyDatabaseRestore(): Promise<string>
  /** `agent-workflow verify-database-migration`. */
  verifyDatabaseMigration(): Promise<string>
}

/** RFC-432: what a session-scoped selection is built from in a standalone session. */
export interface DeploymentSessionStorage {
  readonly db: PersistenceDb
  readonly appHome: string
}

/**
 * RFC-431: every deployment states each selection. The standalone profile builds its values in
 * `standaloneSelections` (`./standalone.ts`), the hosted profile in `./crewstation.ts`; consumers never
 * substitute a default. Three groups:
 * - required: both profiles give a value; RFC-432: a value the standalone deployment can only build from the
 *   session graph is a factory each session calls (standalone: the module's local constructor; hosted: a
 *   closure over the object its profile built);
 * - required, nullable: a capability only the hosted deployment has; standalone states `null`, and a consumer
 *   decides with an explicit `null` check.
 * RFC-433: no selection is optional — what used to be a deployment switch by presence is either a real
 * standalone value (the local execution authority, the post-lock secret box factory) or a nullable capability.
 */
export interface DeploymentSelections {
  // ── Required ──
  applicationConfiguration: ApplicationConfigurationBinding
  workspaceUploads: WorkspaceUploadContentFactory
  isolationWorkspaces: IsolationWorkspaceFactory
  repositoryGitWorkspaces: RepositoryGitWorkspaceFactory
  workspaceReads: RepositoryWorkspaceReadQueries
  workspaceContent: WorkspaceContentEffectsFactory
  readonly workspacePresence: WorkspacePresenceQueries
  /** RFC-370 §10 V20 — hosted: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem: WorkspaceMaintenanceFilesystem
  workspaceExcludeProfiles: WorkspaceExcludeProfileFactory
  employeeCaseWorkspaceEffects: EmployeeCaseWorkspaceEffectsFactory
  /** RFC-370 §10 V16: code-review reads (hosted: of the task volumes). */
  repositoryRevisionContent: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: code-review artifacts (hosted: as object publications). */
  codeReviewArtifacts: CodeReviewArtifactStore
  taskRunSelection: TaskRunRootSelection
  taskArchive: TaskArchiveContentBinding
  taskDeletionEffects: TaskDeletionEffects
  archivedNodeEvents: TaskArchivedEventsReader
  readonly reviewRollbackSnapshots: WorkspaceRollbackSnapshotInspector
  runtimeInventoryContent: TaskRuntimeInventoryContent
  bootExecutionRecovery: BootExecutionRecoveryFactory
  /** RFC-370 §10 V19: where a program tool's contract fixture runs. */
  programFixtureProcess: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below an action workspace. */
  actionWorkspaceEntries: ActionWorkspaceEntries
  readonly recoveredExecutionTaskIds: () => readonly string[]
  /** RFC-370 §9.2 V1 — deployment workers started with execution authority (standalone: none). */
  readonly hostedBackgroundOwners: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement: typeof composeLocalRuntimeManagement
  readonly systemAgentRunFamily: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics: typeof composeLocalMcpDiagnostics
  /** RFC-370 v2 §3.6 — the deployment's credential mechanism. */
  credentials: CredentialAdapterSelection
  customObserverPrograms: CustomObserverProgramFactory
  pluginInstaller: PluginInstallerPort
  resourcePackagePluginArtifacts: ResourcePackagePluginArtifactOwner
  employeePrograms: ProgramArtifactPort
  employeeInputArtifacts: EmployeeInputArtifactPort
  evidenceArtifacts: EvidenceArtifactPort
  /**
   * RFC-431: the graph-development (RFC-396) design artifacts. Hosted: the evidence store itself;
   * standalone: the app home root, where v0.19.3 and later already keep them.
   */
  graphDevelopmentArtifacts: EvidenceArtifactPort
  readonly developmentPurposes: DevelopmentPurposeSelection
  verificationCommands: VerificationCommandEffectsFactory
  repositoryBaselines: RepositoryBaselineEffectsFactory
  actionWorkspaceEffects: ActionWorkspaceEffects

  // ── Required, nullable: hosted-only capabilities; standalone states null ──
  taskInputFiles: TaskInputFiles | null
  humanGateArtifactRecovery: HumanGateArtifactRecovery | null
  beforeEventObservationWrite: ((tx: PersistenceDb) => Promise<void>) | null
  taskRecovery: TaskRecoveryDeploymentSelection | null
  maintenanceEffectsBootstrap: MaintenanceWorkerEffectsDescriptor | null
  readonly initializeExecution: ((initialize: () => Promise<void>) => Promise<void>) | null
  /** RFC-433: hosted database installation; standalone runs its local epoch installation path. */
  readonly databaseInstallation: DaemonDatabaseInstallationPort | null
  /** RFC-370 §10 V17: hosted repository remote reads; standalone keeps the daemon's own mirror clones. */
  readonly repositoryRemote: RepositoryRemoteEffects | null
  readonly crewStationEvents: CrewStationEventIngress | null
  /** RFC-370 §9.2 V3: hosted remote-volume candidate execution; standalone uses the module's per-request local effects. */
  readonly repositoryCandidateEffects: RepositoryCandidateEffectsFactory | null
  readonly conflictMergeWorkspaceEffects: ConflictMergeWorkspaceEffects | null

  // ── Required, session-scoped factories (RFC-432): each session calls them with its own graph ──
  readonly contentStore: (session: DeploymentSessionStorage) => ImportedContentStore
  readonly skillContent: (session: DeploymentSessionStorage) => SkillContentBinding
  readonly reviewArtifacts: (
    session: DeploymentSessionStorage & { readonly content: ImportedContentStore },
  ) => ReviewArtifactSelection
  readonly resourcePackageSkillArtifacts: (
    session: DeploymentSessionStorage,
  ) => ResourcePackageSkillArtifactOwner
  readonly intentArtifacts: (session: DeploymentSessionStorage) => IntentArtifactSelection
  /** Called by a PostgreSQL session only; a SQLite session keeps its legacy recovery adapter. */
  readonly databaseBackup: PostgresqlBackupCoordinatorFactory
  /** RFC-370 §9.2 V3 — hosted: publication network Git in the task volume. */
  readonly repositoryPublicationTransport: typeof createRepositoryPublicationTransport
  readonly developmentWorkspaceRepositoryPreparation: typeof createDevelopmentWorkspaceRepositoryPreparation
  readonly repositoryPreparationEffects: typeof composeLocalRepositoryPreparationEffects
  readonly scratchWorkspaceEffects: typeof composeLocalScratchWorkspaceEffects

  // ── Required, process-scoped (RFC-433) ──
  /**
   * RFC-370 M0 / RFC-433: opened once after the startup lock — standalone reads or creates `appHome/secret.key`
   * (which must not happen before the lock); hosted returns the platform-provided master key's box.
   */
  readonly secretBox: () => SecretBox
  /** RFC-370 v2 H7 — the deployment's execution authority; the standalone one is always active, so it gates nothing. */
  readonly executionAuthority: ExecutionAuthorityPort
}

/** RFC-433: what a session receives — the stated selections, with the secret box opened after the startup lock. */
export type DeploymentSessionSelections = Omit<DeploymentSelections, 'secretBox'> & {
  readonly secretBox: SecretBox
}
