import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionModules,
} from './daemonModules/taskExecution'
import { DAEMON_TASK_EXECUTION_ADAPTERS } from './daemonModules/adapters'
import { createEventAutomationDelegatedContextBinding } from '@/modules/identity-access/composition'
import {
  composeDaemonScheduledTaskModules,
  type DaemonScheduledTaskModules,
} from '@/cli/daemonModules/scheduledTasks'
import {
  composeDaemonIntegrationModules,
  type DaemonIntegrationModules,
} from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules, type DaemonFusionModules } from '@/cli/daemonModules/fusion'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  standaloneModuleAdapters,
} from '@/cli/daemonModules/adapters'
import { composeDaemonMemoryModules } from '@/cli/daemonModules/memory'
import { composeDaemonObservationModules } from '@/cli/daemonModules/observation'
import {
  composeDaemonProviderCore,
  type SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'
import { composeDaemonRepositoryCredentials } from '@/cli/daemonModules/repositoryCredentials'
import { composeDaemonResourceCatalogModules } from '@/cli/daemonModules/resourceCatalog'
import { NotApplicable, type DaemonBootSteps } from './daemonLifecycleProgram'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import { composeDevelopmentPurposeRoot, type DevelopmentPurposeSelection } from '@/server'
import type { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { composeClarifyFollowupGenerator } from '@/modules/task-execution/composition/clarifyFollowupGenerator'
import {
  composeLocalTaskRunRootSelection,
  composeTaskWorkspaceExcludeProfilesFor,
} from '@/modules/task-execution/composition/localTaskRunSelection'
import {
  selectTaskRunRootSelection,
  type TaskRunRootSelection,
} from '@/modules/task-execution/composition/taskRunSelection'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type {
  WorkspaceUploadContentFactory,
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import type {
  PortArtifactContentEffects,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import { composeTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
import type {
  NodeRunPromptContentEffects,
  TaskDeletionEffects,
} from '@/modules/task-execution/public/types'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import {
  selectDevelopmentWorkspaceEffectBinding,
  type ActionWorkspaceEffects,
  type AutomationWorkspaceEffectsFactory,
} from '@/modules/development-automation/composition'
import type { ConflictMergeWorkspaceEffects } from '@/modules/source-control/public/types'
import type {
  RepositoryBaselineEffectsFactory,
  VerificationCommandEffectsFactory,
} from '@/modules/development-automation/composition'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/localVerificationCommands'
import {
  composeLocalExecutionAuthority,
  readDaemonStartupRecoveryAuthority,
  type DaemonStartupLease,
} from '@/modules/system-operations/composition'
import type { RuntimeProfileConfigurationCommands } from '@/modules/runtime-management/public/commands'
import { composeRunObservation } from '@/modules/run-observability/composition/runObservation'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import type { ConfigConcurrencyHotApplyInput } from '@/modules/system-operations/public/commands'
import type {
  ApplicationConfigurationQueries,
  DaemonRuntimeQueries,
} from '@/modules/system-operations/public/queries'
import { selectDaemonRuntimeQueries } from '@/modules/system-operations/composition/daemonHostLifecycle'
import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import {
  composeRepositoryMirrors,
  createFileWorkspaceContentEffects,
  createWorkspaceContentScope,
  type EmployeeCaseWorkspaceEffectsFactory,
  type RepositoryRemoteEffects,
  type WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
import {
  createArtifactProgramToolSource,
  type ScriptFixtureProcess,
} from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionRunners'
// RFC-349 — PostgreSQL daemon application composition.
//
// This file is intentionally a bootstrap composition root. Provider clients
// are captured while owner modules are built and never cross into HTTP, WS or
// public route contracts.

import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'
import type { DigitalEmployeeModuleWithRuntime } from '@/modules/digital-employee/composition'
import { recoverInterruptedTaskDeletes } from '@/modules/task-execution/infrastructure/taskDeleteRecovery'
import {
  createDaemonLockProof,
  createDaemonRecoveryAuthorityProof,
  runTaskExecutionBootRecovery,
  type BootExecutionRecoveryFactory,
} from '@/modules/task-execution/composition/bootRecovery'
import { selectLocalBootExecutionRecoveryFactory } from '@/modules/task-execution/composition/localBootExecutionRecovery'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import type { Config } from '@agent-workflow/shared'
import { join } from 'node:path'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'

import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import {
  composeRuntimeProbeConfigFence,
  type RuntimeDiagnosticDependencies,
} from '@/modules/runtime-management/composition/runtimeManagement'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import { type WebhookDispatcher } from '@/services/webhook/dispatcherTypes'

import { actorOfDirectAuthority, admitDaemonIdentity } from '@/auth/session'
import { composeOidcIdentityOperations } from '@/modules/identity-access/composition/providerOperations'
import { DrizzleOidcProviderRepository } from '@/modules/identity-access/public/operations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import { reconcileRepositoryTransportConnectionProjections } from '@/modules/source-control/composition'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/composition/codeReviewArtifacts'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import type { composePostgresqlMemoryOperations } from '@/modules/memory/composition'

import { composeResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
  composeWorkgroupTaskRoomDynamicWorkflow,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'

import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
  type ResourcePackageSkillArtifactOwner,
  type ResourcePackagePluginArtifactOwner,
  type SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import {
  type SelectedPostgresqlTaskExecutionProviderRuntime,
  type TaskExecutionBackgroundStartDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import { createGateContinuationDriver } from '@/modules/task-execution/public/participants'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
  type WorkspacePresenceQueries,
} from '@/modules/source-control/public/queries'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import {
  readCommittedReviewArtifactBody,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { createPostgresqlCollaborationTaskAccessPort } from '@/modules/collaboration/composition'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { createExecutionContractResourceAdapter } from '@/modules/resource-catalog/composition/executionContractResource'
import {
  composeDigitalEmployeePlatformInventoryParticipant,
  composeDigitalEmployeeTaskCatalogSource,
  composeDigitalEmployee,
  composeDigitalEmployeeBootstrapReadsFor,
  composeDigitalEmployeeWriterCutoverFor,
  createEmployeeInputArtifactStore,
  createEmployeeReactionRoundQueries,
} from '@/modules/digital-employee/composition'

import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { ensureDigitalEmployeeHostWorkflow } from '@/modules/task-execution/composition/actionExecutionRunners'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeReactionExecutionProvider,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composePostgresqlResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import {
  composeTaskIdleTimeoutOperations,
  createPostgresqlTaskIdleTimeoutPersistence,
  type TaskIdleTimeoutOperations,
} from '@/modules/task-execution/composition/taskIdleTimeout'
import { readTaskResourceUsage } from '@/services/limits'
import {
  composeDevelopmentAdmissionLookup,
  composeDevelopmentAutomation,
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
  type AttemptContextStorePort,
} from '@/modules/development-automation/composition'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDevelopmentEmployeeWorkspace,
  createDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentActivityOperations } from '@/modules/development-automation/composition/activityOperations'
import {
  composeDevelopmentMissionOperations,
  createLegacyMissionAdmissionsEnabledQuery,
} from '@/modules/development-automation/composition/missionOperations'
import {
  composeMissionInputUploadOperations,
  type MissionInputBlobPersistence,
} from '@/modules/development-automation/composition/missionInputUploads'
import { composeSelectedRequirementSourceRunnerFor } from '@/modules/integration/composition/requirementSource'

import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
} from '@/services/developmentDeliveryDeps'
import { composeIntentPersistence } from '@/modules/intent/composition/persistence'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import {
  composeIntentApplyArtifactLifecycle,
  composeIntentApplyOperations,
  createIntentSessionWsPublisher,
} from '@/modules/intent/composition/apply'
import { composeIntentContextResourceAuthorizationFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import { composeIntentResourceCatalogFor } from '@/modules/intent/application/resourceCatalog'

import { composeIntentMaintenanceSnapshotQueriesFor } from '@/modules/intent/composition/maintenance'

import type { composeMrTerminalControl } from '@/modules/integration/composition/webhookTerminalControl'

import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'

import { type CustomObserverProgramFactory } from '@/modules/event-center/composition'

import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'

import { createDevelopmentMissionExecutionTerminalObserver } from '@/modules/development-automation/composition/executionTerminalObserver'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'
import { composeSystemOverviewQuery } from '@/modules/system-operations/application/overview'
import {
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { composeWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { cleanupOrphanedGitCredentialLeases } from '@/util/gitCredentialLease'
import { recoverInterruptedDeliveries } from '@/services/webhook/deliveryStore'
import { Paths } from '@/util/paths'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { materializingSpaces } from '@/services/gc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'

import { createLogger } from '@/util/log'
import { runFrameBackfillOnBoot } from '@/modules/task-execution/composition/frameBackfill'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ResolvedDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { createOidcProvidersService } from '@/services/oidcProviders'

import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import { directOperationAuthority } from '@/routes/operationAuthority'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import {
  composePostgresqlAppDeps,
  composeDigitalEmployeeRoutePersistence,
  createComposedApp,
  type UnstartedApplicationScope,
  type PostgresqlAppCompositionInput,
} from '@/server'
import { buildWebSocketAdapter } from '@/ws/server'
import type { FusedIntoSkillMemory, MemoryScopeAuthority } from '@/modules/memory/public/catalog'
import { triggerAuthorityRevalidation } from '@/ws/revalidationHook'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { PRESENCE_CHANNEL, presenceBroadcaster } from '@/ws/broadcaster'
import { composeDaemonRealtimePolicy } from './daemonRealtimePolicy'

import {
  resumeQueuedIntentWorkingSets,
  type IntentDispatchDeps,
} from '@/modules/intent/application/dispatcher'
import { composeIntentWorkflowGraphValidation } from '@/modules/intent/composition/graphValidation'

import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'

const log = createLogger('postgresql-daemon-application')

type PostgresqlProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'postgresql' }
>

export interface PostgresqlDaemonApplicationInput {
  readonly provider: PostgresqlProviderRuntime
  readonly db: PostgresqlDatabaseClient
  readonly config: Config & {
    readonly database: Extract<Config['database'], { readonly provider: 'postgresql' }>
  }
  readonly token: string
  readonly appHome: string
  readonly configPath: string
  readonly configuration?: ApplicationConfigurationQueries
  readonly applicationConfiguration?: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration?: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly taskArchive?: TaskArchiveContentBinding
  readonly skillContent?: SkillContentBinding
  readonly employeePrograms?: ProgramArtifactPort
  /** RFC-370 §10 V19: the hosted task-image fixture run; standalone runs on this host. */
  readonly programFixtureProcess?: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below a hosted action workspace; standalone checks its disk. */
  readonly actionWorkspaceEntries?: ActionWorkspaceEntries
  /** RFC-370 §10 V16: code-review reads of a hosted task volume; standalone reads its worktree. */
  readonly repositoryRevisionContent?: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: hosted code-review artifacts; standalone keeps appHome files. */
  readonly codeReviewArtifacts?: CodeReviewArtifactStore
  readonly employeeInputArtifacts?: EmployeeInputArtifactPort
  readonly missionInputBlobs?: MissionInputBlobPersistence
  readonly pluginInstaller?: PluginInstallerPort
  readonly beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  readonly databaseBackup?: DatabaseBackupEffects
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly intentArtifacts?: IntentArtifactSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly resourcePackageSkillContent?: SkillPackageContentReader
  readonly workspaceContent?: WorkspaceContentEffectsFactory
  /** RFC-370 §10 V17: hosted repository remote reads (system volume); absent, local mirrors. */
  readonly repositoryRemote?: RepositoryRemoteEffects
  readonly workspaceUploads?: WorkspaceUploadContentFactory
  readonly isolationWorkspaces?: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  readonly repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  readonly employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly verificationCommands?: VerificationCommandEffectsFactory
  readonly customObserverPrograms?: CustomObserverProgramFactory
  readonly bootExecutionRecovery?: BootExecutionRecoveryFactory
  /** RFC-370 v2 H7: bootstrap selects the execution authority; standalone by default. */
  readonly executionAuthority?: ExecutionAuthorityPort
  /** RFC-370 v2 §3.6: bootstrap selects the credential mechanism; standalone by default. */
  readonly credentials?: CredentialAdapterSelection
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  readonly taskDeletionEffects?: TaskDeletionEffects
  /** RFC-370 §9.2 V3: a hosted publication's network Git runs in its task volume. */
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  readonly nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  readonly portArtifactContentEffects?: PortArtifactContentEffects
  readonly runtimeInventoryContent?: TaskRuntimeInventoryContent
  readonly taskRunSelection?: TaskRunRootSelection
  readonly taskRecovery?: TaskRecoveryDeploymentSelection
  readonly taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20: the fusion engine task's workspace; standalone under appHome. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
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
  readonly evidenceRead?: EvidenceReadBinding
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly attemptContext?: AttemptContextStorePort
  readonly daemonInfoPath: string
  readonly daemonRuntime?: DaemonRuntimeQueries
  readonly daemonStartupLease?: DaemonStartupLease
  readonly lockPath: string
  readonly secretBox: SecretBox
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly workspaceReads?: RepositoryWorkspaceReadQueries
  /** RFC-349 T10 — see `DatabaseSourceWriteWindow`; bootstrap supplies the live one. */
  readonly sourceWriteWindow?: DatabaseSourceWriteWindow
  readonly databaseMigration: DatabaseMigrationModule
  readonly dbVersion: number
  /**
   * RFC-159 / RFC-359 —— 覆盖定时任务 run-now 的启动闭包。生产不传（下面从
   * `taskExecutionProvider.trigger` 取真的那个），测试注入桩，免得
   * POST /:id/run-now 真去 spawn 一个 opencode 任务。
   *
   * 为什么补这个口子：SQLite 根**早就有**同形的可选覆盖（`server.ts` 的
   * `buildScheduleLaunch?`，取值处 `deps.buildScheduleLaunch ?? …`），PG 根却没有
   * ——两个组合根的**装配签名不对称**，而它恰好挡住 `scheduled-tasks-run-now`
   * 的 AC-6 双引擎迁移。补成同形（默认值不变）比在测试里给 PG 开特例分支干净。
   */
  readonly buildScheduleLaunch?: BuildScheduleLaunch
  /**
   * RFC-284 T26 / RFC-359 —— 运行时诊断的测试注入口（生产两侧都省略）。
   *
   * 与 `buildScheduleLaunch` 同理：`RuntimesRouteDependencies`
   * （`routes/runtimes.ts`）**本来就**声明了这个可选字段，SQLite 根也一直从
   * `deps` 透传进去；PG 根只是没把它从自己的入参转下去，于是同一批运行时诊断
   * 用例在 PG 上没法双跑。这里补的是一次纯透传，不改任何默认行为。
   */
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
  /**
   * RFC-257 / RFC-359 —— 覆盖 webhook 派发器。生产两侧都省略（PG 根自己构造、
   * SQLite 根由 `cli/start.ts` 注入真的那个）；测试注入桩，免得真的去投递。
   *
   * 与另外两个覆盖口不同：两个根对它的**所有权**本来就不同，所以这里不是简单透传
   * ——覆盖件只有部分能力时，事件中心那几处按 `supports*` 探测降级，与 `server.ts`
   * 对同一件事的做法逐字同构。见 plan §5bi。
   */
  readonly webhookDispatcher?: WebhookDispatcher
  /**
   * RFC-238 / RFC-359 —— MCP 运行时测试的测试接缝。生产两侧都省略（用真的 runner 与真时钟）。
   *
   * 与 `runtimeDiagnosticTestDependencies` 同类：SQLite 根一直把这三项条件展开进
   * `composeLocalMcpDiagnostics(...)`（`server.ts` 的 `runFn` / `now` / `capacity`），
   * PG 根建的是**同一个**服务却没转发它们，于是同一批用例在 PG 上没法双跑。
   * `appHome` 不在这里——PG 根本来就从 `input.appHome` 取。
   */
  readonly mcpRuntimeTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    readonly now?: () => number
    readonly capacity?: number
  }
  /**
   * RFC-234 / RFC-359 —— 意图回合的 system-agent 运行接缝。生产两侧都省略。
   * 与 MCP 那一个同理：`IntentSessionRouteDependencies` 本来就有 `runTurn`，
   * SQLite 根一直条件展开进去（`server.ts:2750-2752`），PG 根没转发。
   */
  readonly intentTestDependencies?: {
    readonly runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  readonly maintenanceStatus: NonNullable<
    PostgresqlAppCompositionInput['platform']['maintenance']['maintenanceStatus']
  >
}

export interface PostgresqlApplicationInput extends Omit<
  PostgresqlDaemonApplicationInput,
  'provider' | 'maintenanceStatus'
> {
  readonly provider: Pick<PostgresqlProviderRuntime, 'runtime' | 'telemetry'>
  readonly maintenanceStatus?: PostgresqlDaemonApplicationInput['maintenanceStatus']
  readonly workflowRuntime?: PostgresqlAppCompositionInput['resourceCatalog']['workflows']['runtime']
  readonly opencodeVersion?: string | null
}

export type PostgresqlApplicationPhase =
  | { readonly kind: 'daemon' }
  | { readonly kind: 'unstarted'; readonly scope: UnstartedApplicationScope }

export interface PostgresqlDaemonApplication {
  readonly lifecycleSteps: Omit<
    DaemonBootSteps,
    'runtime-declarations' | 'runtime-registry' | 'maintenance-boot-snapshot'
  >
  readonly core: SelectedDaemonProviderCore<'postgresql'>
  readonly app: ReturnType<typeof createComposedApp>
  readonly webSocket: ReturnType<typeof buildWebSocketAdapter>
  readonly runtime: PostgresqlDaemonApplicationRuntime
}

/**
 * Closed daemon-lifetime participants selected together with the HTTP graph.
 * The start command owns timers and workers; it receives no route dependency
 * builders and cannot accidentally re-compose a second provider graph.
 */
export interface PostgresqlDaemonApplicationRuntime {
  readonly taskExecutionModules: DaemonTaskExecutionModules<'postgresql'>
  readonly taskExecution: SelectedPostgresqlTaskExecutionProviderRuntime
  /**
   * RFC-359 —— 装配好的协作命令上下文。暴露它不是为了给 daemon 用（daemon 不碰它），
   * 而是为了让**测试夹具能把应用自己建的那一份交给用例**。合一前一批用例为了拿到它，
   * 在外面用 `createCollaborationCommandContext({...})` 再建一份一模一样的、再从
   * `AppDeps.collaborationContext` 塞回去——那个形状把用例钉死在 SQLite 上。
   */
  readonly collaborationContext: CollaborationRouteContext
  readonly scheduledTasks: DaemonScheduledTaskModules['scheduledTaskRuntime']
  readonly scheduledTaskIdentityAccess: TaskExecutionBackgroundStartDependencies['scheduled']['identityAccess']
  readonly memory: ReturnType<typeof composePostgresqlMemoryOperations>
  readonly developmentAutomation: ReturnType<typeof composeDevelopmentAutomation>
  readonly digitalEmployee: DigitalEmployeeModuleWithRuntime
  readonly employeeWriterCutover: ReturnType<typeof composeDigitalEmployeeWriterCutoverFor>
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly eventCenter: DaemonIntegrationModules['eventCenter']
  readonly fusion: DaemonFusionModules['fusionOperations']
  readonly resourceLimits: ReturnType<typeof composePostgresqlResourceLimitOperations>
  /** RFC-350：不活跃超时收割（僵尸任务）的 provider-bound operations。 */
  readonly taskIdleTimeout: TaskIdleTimeoutOperations
  readonly mcpRuntimeTests: ReturnType<typeof composeLocalMcpDiagnostics>
  readonly webhookTerminalControl: ReturnType<typeof composeMrTerminalControl>
  readonly workspaceMaintenance: ReturnType<typeof composeWorkspaceMaintenanceCommand>
  readonly intentMaintenance: ReturnType<typeof composeIntentMaintenanceSnapshotQueriesFor>
  readonly resourcePackageActivity: Pick<
    ReturnType<typeof createPostgresqlResourcePackageAtomicApplyOperations>,
    'activeApplyIds'
  >
  readonly resumeIntentSessions: (sessionIds: readonly string[], config: Config) => Promise<void>
  readonly driveHumanGateContinuation: (input: {
    readonly taskId: string
    readonly continuationRef: string
  }) => Promise<void>
}

/**
 * Build one complete PostgreSQL HTTP/WS graph from the already verified live
 * generation. The implementation is filled by the owner-domain compositions
 * below; callers never reopen or reselect a provider.
 */
export async function composePostgresqlDaemonApplication(
  input: PostgresqlDaemonApplicationInput,
): Promise<PostgresqlDaemonApplication> {
  return composePostgresqlApplication(input, { kind: 'daemon' })
}

export async function composePostgresqlApplication(
  input: PostgresqlApplicationInput,
  phase: PostgresqlApplicationPhase,
): Promise<PostgresqlDaemonApplication> {
  const developmentPurposeRoot = composeDevelopmentPurposeRoot({
    appHome: input.appHome,
    selection: input.developmentPurposes,
    evidenceArtifacts: input.evidenceArtifacts,
    evidenceDocumentCommands: input.evidenceDocumentCommands,
  })
  const selectedTaskRuns = selectTaskRunRootSelection(input.taskRunSelection)
  const workspaceExcludeProfilesFor = composeTaskWorkspaceExcludeProfilesFor(
    input.workspaceExcludeProfiles,
  )
  const nodeRunPrompts =
    selectedTaskRuns === undefined
      ? composeNodeRunPromptOperations(
          input.nodeRunPromptContentEffects,
          join(input.appHome, 'runs'),
        )
      : selectedTaskRuns.nodeRunPrompts
  const workspaceUploads = selectWorkspaceUploadContentFactory(input.workspaceUploads)
  const isolationWorkspaces = selectIsolationWorkspaceFactory(input.isolationWorkspaces)
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(input.repositoryGitWorkspaces)
  const workspaceReads = selectRepositoryWorkspaceReadQueries(input.workspaceReads)
  const developmentWorkspaceEffects = selectDevelopmentWorkspaceEffectBinding({
    actionWorkspaceEffects: input.actionWorkspaceEffects,
    automationWorkspaceEffects: input.automationWorkspaceEffects,
    conflictWorkspaceSelected: input.conflictMergeWorkspaceEffects !== undefined,
  })
  const portArtifacts =
    selectedTaskRuns === undefined
      ? composePortArtifactOperations(input.portArtifactContentEffects, input.appHome)
      : selectedTaskRuns.portArtifacts
  const taskRunRoot =
    selectedTaskRuns === undefined
      ? composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts })
      : selectedTaskRuns
  const applicationConfiguration =
    input.applicationConfiguration ??
    composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: input.configPath,
      ...(input.configuration === undefined ? {} : { queries: input.configuration }),
    })
  const configuration = applicationConfiguration.queries
  const taskLaunchConfiguration =
    input.taskLaunchConfiguration ??
    composeTaskLaunchConfiguration(
      input.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: configuration }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
  const realtimePolicy = composeDaemonRealtimePolicy({
    resourceVisibility: {
      canViewResource: (actor, type, row) =>
        resourceCatalog.authorization.canViewResource(actor, type, row),
    },
    memoryVisibility: {
      canViewMemory: (authority, actor, scope) =>
        memoryCatalog.queries.canView({ authority, actor }, scope),
    },
    repoImportOwnerUserId: batchOwnerUserId,
    redactTaskEventPayload: redactEventPayload,
  })
  const core = composeDaemonProviderCore({
    daemonToken: input.token,
    db: input.db,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.sourceWriteWindow === undefined
      ? {}
      : { sourceWriteWindow: input.sourceWriteWindow }),
    adapters: DAEMON_PROVIDER_CORE_ADAPTERS.postgresql({
      db: input.db,
      runtime: input.provider.runtime,
      databaseConfig: input.config.database,
      backup: input.databaseBackup,
      appHome: input.appHome,
      lockPath: input.lockPath,
    }),
    appHome: input.appHome,
    secretBox: input.secretBox,
    realtimePolicy,
    onCredentialRevoked: triggerRevalidation,
    identityEvents: {
      authorityRevisionChanged({ userId, revision, onFailure }) {
        triggerAuthorityRevalidation(userId, revision, onFailure)
      },
    },
    presenceProjection: {
      publish(changes) {
        const [head, ...rest] = changes
        if (head === undefined) return
        presenceBroadcaster.broadcast(PRESENCE_CHANNEL, {
          type: 'presence.changed',
          changes: [head, ...rest],
        })
      },
    },
  })
  // Cold restore is a provider boot hook, not an HTTP/background operation.
  // Apply it while admission is still closed and before any owner module reads
  // the selected schema. A live non-empty target is rejected by the restore
  // coordinator; bootstrap never drops or aliases the active schema.
  if (phase.kind === 'daemon') {
    await core.systemOperations.applyPendingRestore()
  }

  const identityAccess = core.identityAccess
  let systemActor: ReturnType<typeof actorOfDirectAuthority>
  const standalone = standaloneModuleAdapters()
  const observationModules = composeDaemonObservationModules({
    db: input.db,
    appHome: input.appHome,
    configuration,
    notificationKey: applicationConfiguration.notificationKey,
    identityAccess,
    runtimeRegistry: core.runtimeRegistry,
    mcpCatalog: () => mcpCatalog,
    adapters: {
      ...standalone,
      systemAgentRunFamily: input.systemAgentRunFamily ?? standalone.systemAgentRunFamily,
      mcpDiagnostics:
        phase.kind === 'daemon'
          ? (input.mcpDiagnostics ?? standalone.mcpDiagnostics)
          : phase.scope.createMcpRuntimeTests,
      runtimeManagement: input.runtimeManagement ?? standalone.runtimeManagement,
      workspacePresence: () => input.workspacePresence ?? standalone.workspacePresence(),
    },
    mcpRuntimeTestDependencies: input.mcpRuntimeTestDependencies,
    runtimeDiagnosticTestDependencies: input.runtimeDiagnosticTestDependencies,
  })
  const {
    observationCalls,
    memorySystemAgentBinding,
    intentSystemAgentBinding,
    narrativeSystemAgentBinding,
    intentHttpSystemAgentBinding,
    runtimeSessionLeases,
    mcpRuntimeTests,
    runtimeManagement,
  } = observationModules
  const resourceCatalogModules = composeDaemonResourceCatalogModules({
    db: input.db,
    skillContentRoot: input.appHome,
    skillContent: input.skillContent,
    pluginInstaller: input.pluginInstaller,
    runtimeProfiles: { get: (name) => core.runtimeRegistry.getRuntime(name) },
    mcpRuntime: {
      prepareDelete: (id) => mcpRuntimeTests.prepareMcpDelete(id),
      reconcileDurableIntents: () => mcpRuntimeTests.reconcileDurableIntents(),
    },
  })
  const {
    resourceCatalog,
    classicCatalogs,
    skillCatalogBoot,
    mcpProbeStore,
    mcpCatalog,
    pluginCatalog,
    workgroupCatalog,
    digitalEmployeeAgentTemplates,
    capabilityTemplateOperations,
    capabilityTemplateAcl,
    developmentConfigOperations: developmentConfig,
    digitalEmployeeAcl,
    developmentAclRoutes,
  } = resourceCatalogModules
  const repositoryCredentials = composeDaemonRepositoryCredentials({
    db: input.db,
    appHome: input.appHome,
    secretBox: input.secretBox,
    developmentPurposeRoot,
    repositoryWorkspaceStore: core.repositoryWorkspaceStore,
    repositoryWorkspaceOperations: core.repositoryWorkspaceOperations,
    repositoryTransportCredentialRepository: core.repositoryTransportCredentialRepository,
    repositoryPublicationTransport: input.repositoryPublicationTransport,
    developmentWorkspaceRepositoryPreparation: input.developmentWorkspaceRepositoryPreparation,
  })
  const {
    repositoryTransport,
    codeHostConnections,
    repositoryPublicationTransport,
    developmentDeliveryProvider,
    developmentWorkspaceRepositoryPreparation,
  } = repositoryCredentials
  const repositoryTransportRepository = core.repositoryTransportCredentialRepository
  const memoryModules = composeDaemonMemoryModules({
    db: input.db,
    nodeRunPrompts,
    systemAgentBinding: memorySystemAgentBinding,
    contexts: identityAccess.contexts,
    reviewedArtifacts: {
      read: async (finalPath) =>
        await readCommittedReviewArtifactBody(boundCollaborationContext, finalPath),
    },
  })
  const { memoryOperations, memoryCatalog } = memoryModules
  const authorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const oidcIdentities = composeOidcIdentityOperations({
    db: input.db,
    identityAccess,
  })
  const oidcProviders = createOidcProvidersService({
    repository: new DrizzleOidcProviderRepository(input.db),
    secretBox: input.secretBox,
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: core.authRuntime,
    afterDisabled: async () => await mcpRuntimeTests.reconcileDurableIntents(),
  })

  const codeHistoryQueries = composeCodeHistoryQueries(input.db)
  // RFC-370 §10 V19: program tools read the same store the employee authoring
  // wrote (platform objects when hosted, the application home standalone).
  const programToolSource =
    input.employeePrograms === undefined
      ? undefined
      : createArtifactProgramToolSource(input.employeePrograms)
  const executionContracts = composeExecutionContract({
    resources: createExecutionContractResourceAdapter(
      input.db,
      developmentImplicitAgentContractDeclarations,
    ),
    registrations: developmentExecutionContractRegistrations,
    programFixtures: createExecutionContractProgramFixtureAdapter({
      appHome: input.appHome,
      ...(programToolSource === undefined ? {} : { programs: programToolSource }),
      ...(input.programFixtureProcess === undefined
        ? {}
        : { process: input.programFixtureProcess }),
    }),
  })
  type PostgresqlResourcePackageProviderInput = Parameters<
    typeof composePostgresqlResourcePackageProvider
  >[0]
  type PackageAuthority = Parameters<
    PostgresqlResourcePackageProviderInput['authorityResolver']['resolve']
  >[0]
  const packageActors = new WeakMap<PackageAuthority, Actor>()
  const resourcePackageProvider = composePostgresqlResourcePackageProvider({
    db: input.db,
    appHome: input.appHome,
    authorityResolver: Object.freeze({
      resolve(authority: PackageAuthority) {
        const actor = packageActors.get(authority)
        if (actor === undefined) throw new Error('foreign-resource-package-authority')
        return actor
      },
    }),
    mcpLifecycle: resourceCatalogModules.mcpTransactionLifecycle,
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({ db: input.db }),
    skillArtifacts: input.resourcePackageSkillArtifacts,
    skillPackageContent: input.resourcePackageSkillContent,
    ...(input.resourcePackagePluginArtifacts === undefined
      ? {
          pluginInstaller: Object.freeze({
            plannedGenerationDirectory(
              request: Parameters<
                NonNullable<
                  PostgresqlResourcePackageProviderInput['pluginInstaller']
                >['plannedGenerationDirectory']
              >[0],
            ) {
              return plannedGenerationDir(
                request.pluginId,
                request.spec,
                request.generationId,
                request.pluginsDir,
              )
            },
            async install(
              request: Parameters<
                NonNullable<PostgresqlResourcePackageProviderInput['pluginInstaller']>['install']
              >[0],
            ) {
              const installed = await installPlugin(request.pluginId, request.spec, {
                generationId: request.generationId,
                pluginsDir: request.pluginsDir,
              })
              return {
                cachedPath: installed.cachedPath,
                resolvedVersion: installed.resolvedVersion,
                sourceKind: installed.sourceKind,
                generationDirectory: installed.generationDir,
              }
            },
          }),
        }
      : { pluginArtifacts: input.resourcePackagePluginArtifacts }),
  })
  const resourcePackageAtomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
    db: input.db,
    box: input.secretBox,
  })
  const resourcePackageCatalog = composePostgresqlResourcePackageCatalog({
    provider: resourcePackageProvider,
    execution: createPostgresqlResourcePackageExecutionAdapter({
      box: input.secretBox,
      provider: resourcePackageProvider,
      atomicApply: resourcePackageAtomicApply,
    }),
  })
  const taskExecutionModules: DaemonTaskExecutionModules<'postgresql'> =
    composeDaemonTaskExecutionModules({
      db: input.db,
      appHome: input.appHome,
      configPath: input.configPath,
      secretBox: input.secretBox,
      taskLaunchConfiguration,
      adapters: DAEMON_TASK_EXECUTION_ADAPTERS.postgresql({
        db: input.db,
        runtime: input.provider.runtime,
      }),
      core,
      observation: observationModules,
      resources: {
        agentResourceIntegrity: classicCatalogs.agentResourceIntegrity,
        owners: composeOwnerIdentityQueries(input.db),
      },
      repository: repositoryCredentials,
      memory: memoryModules,
      selection: {
        taskRunBinding: taskRunRoot.drive,
        workspaceExcludeProfilesFor,
        nodeRunPrompts,
        portArtifacts,
        isolationWorkspaces,
        repositoryGitWorkspaces,
        archive: input.taskArchive,
        workspaceReads,
        effects: input.taskDeletionEffects,
        archivedEvents: input.archivedNodeEvents,
        reviewArtifacts: input.reviewArtifacts,
        reviewRollbackSnapshots: input.reviewRollbackSnapshots,
        workspaceUploads,
        inputFiles: input.taskInputFiles,
        preparationEffects: input.repositoryPreparationEffects,
        scratchEffects: input.scratchWorkspaceEffects,
        recoverySelection: input.taskRecovery?.(identityAccess),
        fusionWorkspaces:
          input.fusionWorkspaceEffects ??
          createFileFusionWorkspaceEffects({ appHome: input.appHome }),
      },
      alerts: {
        onAlert(row, transition) {
          tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
            type: 'lifecycle.alert',
            taskId: row.taskId,
            rule: row.rule,
            severity: row.severity,
            transition,
          })
        },
        onResolved(taskId) {
          tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
            type: 'lifecycle.alert.resolved',
            taskId,
          })
        },
      },
      fusionRunConfiguration: () => fusionModules.runConfiguration(),
      finalizeWorkspace: (taskId) => workspaceMaintenance.finalizeClaimedWorkspace(taskId),
    })
  const taskExecutionProvider = taskExecutionModules
  const taskExecutionResources = taskExecutionModules.resources
  const taskExecutionPersistence = taskExecutionModules.persistence
  const boundCollaborationContext = taskExecutionModules.collaboration
  const validationContext = taskExecutionModules.validationContext
  const taskDriveCoordinator = taskExecutionModules.coordinator
  const workspaceMaintenance = composeWorkspaceMaintenanceCommand({
    filesystem: input.workspaceMaintenanceFilesystem,
    db: input.db,
    appHome: input.appHome,
    terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: invalidateCallGraphIndex,
  })

  const codeWorkspace = composeLegacyCodeReadProviders(input.db).workspace
  const collaborationTaskAccess = createPostgresqlCollaborationTaskAccessPort(input.db)
  const taskRoutes = Object.freeze({
    configuration,
    operations: taskExecutionProvider.routes.tasks,
    workspaceQueries: composeTaskWorkspaceQueries({
      load: taskExecutionProvider.routes.tasks.get,
      contentScope: (workspaceRef) =>
        createWorkspaceContentScope(workspaceRef, input.workspaceContent),
    }),
    taskExecutionReadModels: taskExecutionProvider.readModels,
    runtimeInventoryContent: composeTaskRuntimeInventoryContent(input.runtimeInventoryContent),
    taskRecoveryOperations: taskExecutionProvider.recovery,
    codeWorkspace,
    // RFC-370 §10 V16: hosted reads answer from the task volume and persist as
    // object publications; standalone PostgreSQL keeps native worktrees and files.
    codeReview: Object.freeze({
      content: input.repositoryRevisionContent ?? composeLocalRepositoryRevisionContent(),
      artifacts: input.codeReviewArtifacts ?? composeLocalCodeReviewArtifacts(),
    }),
    repositoryWorkspace: core.repositoryWorkspaceStore,
    changeNarrative: Object.freeze({
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(boundCollaborationContext, {
          actor,
          taskId,
        })
        if (access.task === null) {
          const { NotFoundError } = await import('@/util/errors')
          throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        }
        if (access.actorRole === null) {
          const { ForbiddenError } = await import('@/util/errors')
          throw new ForbiddenError(
            'not-task-member',
            'only task members or an actor with the required global task authority can do this',
          )
        }
      },
      resolveRuntime: ({
        runtimeName,
        defaultRuntime,
      }: {
        readonly runtimeName: string | null
        readonly defaultRuntime: string | null
      }) =>
        core.runtimeRegistry
          .resolveRuntimeByName(runtimeName ?? defaultRuntime)
          .then(narrativeSystemAgentBinding.bindRuntime),
      systemAgents: narrativeSystemAgentBinding.family,
    }),
  })
  const worktreeFiles = Object.freeze({
    store: core.repositoryWorkspaceStore,
    canViewTask: async (actor: Actor, task: { readonly id: string }) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
    // RFC-370 §10 V15: the same content the task workspace queries read.
    content: (workspaceRef: string) =>
      input.workspaceContent?.bind(workspaceRef) ?? createFileWorkspaceContentEffects(workspaceRef),
  })
  const collaborationRouteOperations = composeCollaborationRouteOperations({
    followupGenerator: composeClarifyFollowupGenerator({
      db: input.db,
      registry: core.runtimeRegistry,
      binding: narrativeSystemAgentBinding,
    }),
    db: input.db,
    context: boundCollaborationContext,
  })
  const fusionModules: DaemonFusionModules = composeDaemonFusionModules({
    db: input.db,
    appHome: input.appHome,
    skillContent: input.skillContent,
    memories: memoryCatalog,
    tasks: taskExecutionProvider.fusion,
    taskLaunchConfiguration,
    configPath: input.configPath,
    daemonGeneration: input.provider.runtime.generationId,
  })
  const { fusionOperations } = fusionModules
  // RFC-223 PR-4 / RFC-359 W3-T15：融合 provenance 修复必须在任何融合恢复 / 播种 / HTTP 观察到历史
  // name-only 行之前完成。fail-closed：不包 try，修复失败即 daemon 不起（与 cli/start.ts 同）。
  const taskExecutionCatalogSources = taskExecutionModules.catalogSources
  const workgroupTaskRoom = composeWorkgroupTaskRoom({
    db: input.db,
    taskParticipantFactory: taskExecutionProvider.workgroupTaskRoom,
    activeUsers: composeWorkgroupTaskRoomActiveUsers({
      userDirectory: identityAccess.userDirectory,
    }),
    dynamicWorkflow: composeWorkgroupTaskRoomDynamicWorkflow({
      validationContext,
      workflows: classicCatalogs.workflow.operations.create,
    }),
    systemUserId: SYSTEM_USER_ID,
    continuation: taskExecutionModules.roomContinuation,
    broadcast(taskId, event) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...event })
    },
  })

  const scheduledTaskModules = composeDaemonScheduledTaskModules({
    db: input.db,
    assertAgentIntegrity: (agentIds) =>
      classicCatalogs.agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
  })
  const { scheduledTaskRuntime } = scheduledTaskModules
  const integrationIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionResources,
  })
  const digitalEmployeeWorkStart = Object.freeze<DigitalEmployeeWorkStartPort>({
    async launch(request) {
      const result = await digitalEmployee.runtime.commands.launchWork({
        employeeId: request.employeeId,
        intake: request.intake,
        actorUserId: request.actorUserId,
        eventOrigin: request.origin,
      })
      return { caseId: result.caseRef.id }
    },
  })
  const integrationModules = composeDaemonIntegrationModules({
    db: input.db,
    secretBox: input.secretBox,
    configuration,
    scheduledTaskRuntime,
    identityAccess: integrationIdentityAccess,
    bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
    runtimeRegistry: taskExecutionProvider.executionModule.runtimeRegistry,
    workspaceMaintenance,
    taskExecutions: taskExecutionProvider.trigger.taskExecutions,
    digitalEmployeeWorkStart,
    developmentDeliveryProvider,
    developmentPurposeRoot,
    adapters: {
      customObserverPrograms: input.customObserverPrograms,
      beforeEventObservationWrite: input.beforeEventObservationWrite,
      crewStationEvents: input.crewStationEvents,
      webhookDispatcher: input.webhookDispatcher,
    },
  })
  const {
    webhookTerminalControl,
    webhookDispatcher,
    webhookDeliveryRuntime,
    webhookTriggerService,
    developmentApprovalGateway,
    eventCenter,
  } = integrationModules
  const integrationRoutes: PostgresqlAppCompositionInput['integration'] = Object.freeze({
    scheduledTasks: Object.freeze({
      identityAccess: integrationIdentityAccess,
      scheduledTaskRuntime,
      buildScheduleLaunch:
        input.buildScheduleLaunch ?? taskExecutionProvider.trigger.buildScheduleLaunch,
      getDefaultRuntime: async () => (await configuration.read()).defaultRuntime ?? null,
    }),
    webhookEndpoints: Object.freeze({
      webhookEndpointService: integrationModules.webhookEndpointService,
    }),
    eventCenter,
    webhookTriggers: Object.freeze({
      deps: Object.freeze({ webhookTriggerService }),
      identityAccess: integrationIdentityAccess,
    }),
    webhookDeliveries: Object.freeze({
      webhookDeliveryRuntime,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  const employeeInputArtifacts =
    input.employeeInputArtifacts ??
    createEmployeeInputArtifactStore(join(input.appHome, 'artifacts', 'employee-inputs'))
  const employeeReactionRounds = createEmployeeReactionRoundQueries(input.db)
  const employeeWorkspace = composeDevelopmentEmployeeWorkspace({
    automationWorkspaceEffects: developmentWorkspaceEffects.automationWorkspaceEffects,
    db: input.db,
    appHome: input.appHome,
    reactionRounds: employeeReactionRounds,
    inputArtifacts: employeeInputArtifacts,
    repositoryPreparation: developmentWorkspaceRepositoryPreparation,
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
      effects: input.employeeCaseWorkspaceEffects,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: input.conflictMergeWorkspaceEffects }),
  })
  const employeeDelivery = buildDevelopmentDeliveryDeps(
    developmentDeliveryProvider,
    developmentPurposeRoot.pipeline.staging,
  )
  const employeePlatformWorkItems = composeDevelopmentEmployeePlatformWorkItems({
    automationWorkspaceEffects: developmentWorkspaceEffects.automationWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    evidenceArtifacts: input.evidenceArtifacts,
    db: input.db,
    appHome: input.appHome,
    reactionRounds: employeeReactionRounds,
    approvalGateway: developmentApprovalGateway,
    ...employeeDelivery,
    conflictMerge: bindConflictMergeParticipant({ effects: input.conflictMergeWorkspaceEffects }),
    sourceControl: {
      ...bindChangeCandidateParticipant({ candidateEffects: input.repositoryCandidateEffects }),
      ...bindCandidateDeliveryParticipant({
        candidateEffects: input.repositoryCandidateEffects,
        publicationTransport: repositoryPublicationTransport,
      }),
      ...bindEmployeeCaseWorkspaceParticipant({
        publicationTransport: repositoryPublicationTransport,
        effects: input.employeeCaseWorkspaceEffects,
      }),
    },
  })
  const taskLaunchKernel = taskExecutionProvider.routeLaunch.workflow
  // RFC-368 实现门 P2-1：资源上限与空闲收割都带真实原因取消（`resource-reaped`），状态与原因
  // 同一次写入落下——此前按 `user` 取消、事后改写原因，中间几秒像是用户取消的。
  const resourceLimitOperations = composePostgresqlResourceLimitOperations({
    db: input.db,
    cancelTask: (taskId, reason) =>
      taskExecutionProvider.cancellation.cancel({
        taskId,
        cause: { kind: 'resource-reaped', ...reason },
      }),
  })
  const taskIdleTimeoutOperations = composeTaskIdleTimeoutOperations({
    persistence: createPostgresqlTaskIdleTimeoutPersistence(input.db),
    cancelTask: (taskId, reason) =>
      taskExecutionProvider.cancellation.cancel({
        taskId,
        cause: { kind: 'resource-reaped', ...reason },
      }),
  })
  // RFC-368 T17 —— Reaction 执行走 `ReactionExecutionPortV1` + 同事务 admission 参与者。
  const employeeExecution = composeReactionExecutionProvider({
    db: input.db,
    appHome: input.appHome,
    ...(programToolSource === undefined ? {} : { programs: programToolSource }),
    resolveActor: async () => systemActor,
    resourceAuthorityFor: (actor) => ({
      actor,
      authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources: taskExecutionResources,
    }),
    launch: taskLaunchKernel,
    // 2026-09-19 回补：合成宿主工作流行的幂等播种（合一时丢了，见
    // `composition/digitalEmployeeExecution.ts` 的 `hostWorkflow` 端口注释）。
    hostWorkflow: { ensure: () => ensureDigitalEmployeeHostWorkflow(input.db) },
    tasks: taskExecutionProvider.routes.tasks,
    readModels: taskExecutionProvider.readModels,
    resourceUsage: {
      read: (taskId) => readTaskResourceUsage(resourceLimitOperations, taskId),
    },
    agents: {
      get: (id) => classicCatalogs.agent.queries.get(authorityFor(systemActor), { id }),
    },
    workflows: {
      get: (id) => classicCatalogs.workflow.queries.get(authorityFor(systemActor), { id }),
    },
    // 这两个读点（按 taskId 取 round/恢复开关、按 round 反查已起过的执行）在两个引擎上
    // 逐字相同，装的就是同一份中立实现——此前 PG 侧抄了一份 `load`，而 E9-C 前置小修要加的
    // `findByRound` 一旦也各抄一份，`launch` 的幂等判据就会在两个引擎上各修一次。
    executionMetadata: composeDatabaseDigitalEmployeeExecutionPorts(input.db).executionMetadata,
    // RFC-359：计划人审闸门的状态读装的是与 SQLite 侧**同一个**中立实现；此前 PG 侧根本没有这个
    // 方法，闸门只能按 round 状态推断、永远报不出 `waiting`（同一个案子两个引擎显示不同）。
    // RFC-368：直接复用中立实现（与 executionMetadata 同理），返回六态快照——
    // `unknown`（执行行不在）与 `not-applicable`（没配闸门）在这里分开，旧 participant 自己折回 null。
    humanReview: composeDatabaseDigitalEmployeeExecutionPorts(input.db).humanReview,
    workspace: employeeWorkspace,
    executionContracts,
  })
  const digitalEmployeePlatformTools = composeDigitalEmployeeBuiltinToolCatalog({
    agentTemplates: digitalEmployeeAgentTemplates,
    typePackageDescriptorJsons: async () => [
      ...(await composeDigitalEmployeeBootstrapReadsFor(input.db).listTypePackageDescriptorJsons()),
      developmentEmployeeTypePackage.descriptorJson,
    ],
  })
  const digitalEmployee = composeDigitalEmployee({
    db: input.db,
    appHome: input.appHome,
    programArtifacts: input.employeePrograms,
    typePackages: [developmentEmployeeTypePackage],
    platformTools: digitalEmployeePlatformTools,
    onAutomaticUpgradeIssue(issue) {
      log.warn('automatic digital employee type upgrade could not prove compatibility', {
        ...issue,
      })
    },
    executionContracts,
    retryLimits: {
      async current() {
        const current = await configuration.read()
        return {
          defaultNodeRetries: current.defaultNodeRetries,
          sessionRestartBudget: current.sessionRestartBudget,
        }
      },
    },
    inputArtifacts: employeeInputArtifacts,
    connectionCatalog: integrationModules.developmentToolConnections,
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants: [
        composeDevelopmentEmployeeCaseDetailProjection(
          createDevelopmentEmployeeCaseWorkspaceDetailReader(input.db),
        ),
      ],
      reactionExecution: employeeExecution,
      platformWorkItems: employeePlatformWorkItems,
    },
  })
  const employeeWriterCutover = composeDigitalEmployeeWriterCutoverFor(input.db)
  // RFC-359 W11：worker 是必填实参，装配到此为止；此前是 `createDevelopmentActivityWorkerBinding()`
  // 加下一行一句 `.bind(...)`，两行之间那段「已经能被调用但还没装配」的窗口从来没有用处。
  const developmentActivityOperations = composeDevelopmentActivityOperations(
    digitalEmployee.runtime.worker,
  )

  const developmentAdmissionLookup = composeDevelopmentAdmissionLookup(input.db)
  // RFC-359 W1-T3（F-H2-2）：agent / script 动作 launcher 与执行终态观察者——与 cli/start.ts 同一份
  // 执行器（actionExecutionRunners.ts），只是宿主任务的启动 / 取消换成 PG 的根启动内核与取消命令。
  // 此前 PG daemon 一个都没接，development mission 的每个动作都被 `*-launcher-not-wired` 挡下。
  // RFC-359 W11：终态观察者要回调 `developmentAutomation.drive`，而 automation 的两个 launcher
  // 又要这个观察者。环打在**词法作用域**上：`developmentAutomation` 是同一作用域里的 `const`
  // （下面几十行），闭包只在运行期取值，没有可空盒子、也没有「还没装配」的分支。
  const developmentTerminalObserver = createDevelopmentMissionExecutionTerminalObserver({
    db: input.db,
    async drive(missionId) {
      try {
        const outcome = await developmentAutomation.drive(missionId)
        if (outcome.stop === 'step-budget') {
          log.warn('development mission drive reached its bounded step budget', {
            missionId,
            steps: outcome.steps,
          })
        }
        return outcome
      } catch (err) {
        log.warn('development mission drive after execution terminal failed', {
          missionId,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  })
  const actionExecutionEnvironment = {
    db: input.db,
    resolveActor: async () => systemActor,
    resourceAuthorityFor: (actor: Actor) => ({
      actor,
      authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources: taskExecutionResources,
    }),
    launch: taskLaunchKernel,
    cancelTask: (taskId: string) =>
      taskExecutionProvider.cancellation.cancel({ taskId, cause: { kind: 'user' } }),
    readModels: taskExecutionProvider.readModels,
    agents: {
      get: (id: string) => classicCatalogs.agent.queries.get(authorityFor(systemActor), { id }),
    },
    ...(input.actionWorkspaceEntries === undefined
      ? {}
      : { workspaceEntries: input.actionWorkspaceEntries }),
  }
  const developmentAutomation = composeDevelopmentAutomation({
    verificationCommands:
      input.verificationCommands === undefined
        ? createLocalVerificationCommandEffectsFactory()
        : input.verificationCommands,
    actionWorkspaceEffects: developmentWorkspaceEffects.actionWorkspaceEffects,
    automationWorkspaceEffects: developmentWorkspaceEffects.automationWorkspaceEffects,
    repositoryBaselines: input.repositoryBaselines,
    db: input.db,
    appHome: input.appHome,
    evidenceArtifacts: developmentPurposeRoot.evidenceArtifacts,
    evidenceRead: input.evidenceRead,
    evidenceDocumentCommands: developmentPurposeRoot.requirement.documentCommands,
    requirementStaging: developmentPurposeRoot.requirement.staging,
    attemptContext: input.attemptContext,
    admissionLookup: developmentAdmissionLookup,
    requirementSource: composeSelectedRequirementSourceRunnerFor(
      input.db,
      developmentPurposeRoot.requirement,
    ),
    changeCandidate: bindChangeCandidateParticipant({
      candidateEffects: input.repositoryCandidateEffects,
    }),
    candidateDelivery: bindCandidateDeliveryParticipant({
      candidateEffects: input.repositoryCandidateEffects,
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: input.conflictMergeWorkspaceEffects }),
    ...buildDevelopmentDeliveryDeps(
      developmentDeliveryProvider,
      developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentPipelineDeps(
      developmentDeliveryProvider.pipeline,
      developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentMrFactsDeps(developmentDeliveryProvider),
    approvalGateway: developmentApprovalGateway,
    agentLauncher: composeAgentActionExecution({
      ...actionExecutionEnvironment,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.agent(executionRef)
      },
    }),
    scriptLauncher: composeScriptActionExecution({
      ...actionExecutionEnvironment,
      onTerminal: (executionRef) => {
        void developmentTerminalObserver.script(executionRef)
      },
    }),
  })
  const developmentMissions = composeDevelopmentMissionOperations({
    repositoryBaselines: input.repositoryBaselines,
    db: input.db,
    deliveryProvider: developmentDeliveryProvider,
    admissionLookup: developmentAdmissionLookup,
    automation: developmentAutomation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(
      composeDigitalEmployeeWriterCutoverFor(input.db),
    ),
  })
  // RFC-359 W4-D6c：employee_* 的 ACL 与 SQLite 根同一条目录中立 foreign-owner 路径，identity 行由
  // digital-employee 在目录写事务里交出；PG 专属的 foreign ACL 适配器退役。
  const digitalEmployeePersistence = composeDigitalEmployeeRoutePersistence({
    identityAccess,
    resourceCatalog,
    acl: {
      getResourceAcl: (actor, type, row) =>
        digitalEmployeeAcl[type].getResourceAcl(actor, type, row),
      updateResourceAcl: (actor, type, row, body, options) =>
        digitalEmployeeAcl[type].updateResourceAcl(actor, type, row, body, {
          ...(options?.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        }),
    },
  })
  const digitalDevelopmentRoutes: PostgresqlAppCompositionInput['digitalDevelopment'] =
    Object.freeze({
      executionContracts,
      digitalEmployees: Object.freeze({
        persistence: digitalEmployeePersistence,
        module: digitalEmployee,
        activityOperations: developmentActivityOperations,
        contexts: identityAccess.directAuthority,
      }),
      developmentConfig: Object.freeze({
        aclRoutes: developmentAclRoutes,
        operations: developmentConfig,
        contexts: identityAccess.directAuthority,
      }),
      developmentMissions: Object.freeze({
        operations: developmentMissions,
        contexts: identityAccess.directAuthority,
      }),
      missionInputUploads: composeMissionInputUploadOperations({
        db: input.db,
        appHome: input.appHome,
        blobs: input.missionInputBlobs,
        artifacts: input.evidenceArtifacts,
      }),
    })

  const intentAuthorityFor = (actor: Actor) => authorityFor(actor)
  const intentCatalogActors = new WeakMap<object, Actor>()
  const intentResourceCatalogFor = composeIntentResourceCatalogFor({
    query: resourceCatalog.createQuery({
      resolveActor(context) {
        const actor = intentCatalogActors.get(context)
        if (actor === undefined) throw new Error('intent-resource-catalog-context-not-bound')
        return actor
      },
    }),
    contextFor(actor) {
      const context = identityAccess.contexts.queryFromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      intentCatalogActors.set(context, actor)
      return context
    },
    authorityFor: intentAuthorityFor,
    catalogs: {
      agents: classicCatalogs.agent.queries,
      skills: classicCatalogs.skill.queries,
      skillFiles: classicCatalogs.skill.fileQueries,
      mcps: mcpCatalog.queries,
      plugins: pluginCatalog.queries,
      workflows: classicCatalogs.workflow.queries,
      workgroups: workgroupCatalog.queries,
    },
  })
  const intentPersistence = composeIntentPersistence({
    db: input.db,
    contextAuthorization: composeIntentContextResourceAuthorizationFactory(),
  })
  const intentArtifactRecovery = composeIntentApplyArtifactLifecycle({
    db: input.db,
    appHome: input.appHome,
    content: input.intentArtifacts?.artifactContent,
  })
  // RFC-359 —— 与 SQLite 根**逐字同一份**装配（`composeIntentApplyOperations`）。
  const intentApplyOperations = composeIntentApplyOperations({
    db: input.db,
    appHome: input.appHome,
    ...input.intentArtifacts,
    aclIdentities: resourceCatalog.persistence.identities,
    artifacts: intentArtifactRecovery,
    // RFC-358 §7（AC-6）—— 与 SQLite provider 同一道门、同一份判据。
    graphValidation: composeIntentWorkflowGraphValidation({
      validationQueries: classicCatalogs.workflow.validationQueries,
      workflowQueries: classicCatalogs.workflow.queries,
      authorityFor,
    }),
  })
  const intentApply = intentApplyOperations
  const intentPlatformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor: intentAuthorityFor,
    capabilityTemplates: capabilityTemplateOperations,
    developmentConfig,
    digitalEmployee: composeDigitalEmployeePlatformInventoryParticipant({
      queries: digitalEmployee.queries,
      access: resourceCatalog.authorization,
    }),
  })
  const intentDumpAuxiliary = composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistence,
    defaultRuntime: (await configuration.read()).defaultRuntime ?? 'opencode',
    platformInventory: intentPlatformInventory,
  })
  const intentSessionEvents = createIntentSessionWsPublisher()
  const intentDispatchDeps: Omit<IntentDispatchDeps, 'configSnapshot'> = Object.freeze({
    persistence: intentPersistence,
    events: intentSessionEvents,
    identityAccess: Object.freeze({ directAuthority: identityAccess.directAuthority }),
    appHome: input.appHome,
    runtimeResolver: composeIntentTurnRuntimeResolver(
      intentPersistence,
      intentSystemAgentBinding.bindRuntime,
    ),
    systemAgents: intentSystemAgentBinding.family,
    dumpAuxiliary: intentDumpAuxiliary,
    // RFC-358: 两个 provider 的意图链路跑同一份图校验合同。
    graphValidation: composeIntentWorkflowGraphValidation({
      validationQueries: classicCatalogs.workflow.validationQueries,
      workflowQueries: classicCatalogs.workflow.queries,
      authorityFor,
    }),
    resourceCatalogFor: intentResourceCatalogFor,
  })
  const intentMaintenance = composeIntentMaintenanceSnapshotQueriesFor({
    db: input.db,
    activity: intentApplyOperations,
  })
  const intentRouteInputs: PostgresqlAppCompositionInput['intent'] = {
    appHome: input.appHome,
    configuration,
    events: intentSessionEvents,
    identityAccess,
    directAuthority: identityAccess.directAuthority,
    intentApply,
    intentPersistence,
    intentTurnRuntime: Object.freeze({
      runtimeResolver: composeIntentTurnRuntimeResolver(
        intentPersistence,
        intentHttpSystemAgentBinding.bindRuntime,
      ),
      systemAgents: intentHttpSystemAgentBinding.family,
      dumpAuxiliary: intentDumpAuxiliary,
      graphValidation: composeIntentWorkflowGraphValidation({
        validationQueries: classicCatalogs.workflow.validationQueries,
        workflowQueries: classicCatalogs.workflow.queries,
        authorityFor,
      }),
    }),
    resourceCatalogFor: intentResourceCatalogFor,
  }
  const intentRoutes: PostgresqlAppCompositionInput['intent'] = Object.freeze({
    ...intentRouteInputs,
    // The explicit HTTP fixture replaces the whole family; queued recovery
    // keeps the independently selected production family above.
    ...(input.intentTestDependencies?.runFn === undefined
      ? {}
      : {
          intentTurnRuntime: Object.freeze({
            ...intentRouteInputs.intentTurnRuntime,
            systemAgents: intentHttpSystemAgentBinding.withFixture(
              input.intentTestDependencies.runFn,
            ).family,
          }),
        }),
  })
  const taskCatalog = composeTaskCatalog({
    sources: [
      ...taskExecutionCatalogSources,
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })

  const publicRoutes: PostgresqlAppCompositionInput['public'] = Object.freeze({
    health: Object.freeze({
      deps: Object.freeze({
        opencodeVersion: phase.kind === 'daemon' ? null : (input.opencodeVersion ?? null),
        dbVersion: input.dbVersion,
      }),
      identityAccess: identityAccess.diagnostics,
      database: core.healthDatabase,
    }),
    documentation: Object.freeze({ configuration }),
    webhookIngress: composeWebhookIngressTransport({
      crewStationEvents: integrationModules.crewStationEvents,
      webhookIngressPersistence: integrationModules.webhookIngressPersistence,
      secretBox: input.secretBox,
      digitalEmployeeEventCenter: eventCenter,
      webhookDispatcher,
      webhookTerminalControl,
    }),
  })

  // RFC-359 W57：`/api/overview` 两个 provider 共用这一份装配（SQLite 侧见
  // `server.ts` 的 `composeSqliteApiRouteMounts`）。原来这里还有一张
  // `WeakMap<authority, Actor>` 加一层 execute 包装，用来把请求上下文反查回 actor——
  // 目录概览端口现在直接收 actor，那层胶水连同它的 `foreign-overview-authority` 失败模式
  // 一并删除。
  const overviewQuery: PostgresqlAppCompositionInput['platform']['overview']['query'] =
    composeSystemOverviewQuery({
      resourceCatalog: composeResourceCatalogOverviewQuery(input.db),
      repositories: core.repositoryWorkspaceOperations.overviewQueries,
      integration: scheduledTaskRuntime.overview,
      memories: memoryCatalog,
      tasks: taskExecutionProvider.overview,
    })
  const platformRoutes: PostgresqlAppCompositionInput['platform'] = Object.freeze({
    observability: composeRunObservation({
      db: input.db,
      tasks: createTaskObservationFacts(input.db),
      runtimes: runtimeManagement.observations,
    }),
    config: Object.freeze({
      configuration: applicationConfiguration.composeCommands({
        runtimeRegistry:
          runtimeManagement.configuration satisfies RuntimeProfileConfigurationCommands,
        withRuntimeProbeConfigFence: composeRuntimeProbeConfigFence(
          applicationConfiguration.notificationKey,
        ),
        runtimeTests: mcpRuntimeTests.reconciliation,
        concurrencyHotApply: Object.freeze({
          apply(next: ConfigConcurrencyHotApplyInput) {
            resizeAllNodePools(input.provider.runtime, {
              agent: next.maxConcurrentNodes,
              script: next.maxConcurrentScriptNodes,
              'code-host': next.maxConcurrentCodeHostCalls,
            })
            resizeAllTaskFanoutSems(next.multiProcessSubprocessConcurrency)
            setChildTaskBudgetCapacity(next.maxActiveChildTasks)
          },
        }),
      }),
    }),
    maintenance: Object.freeze({
      configuration,
      maintenanceStatus: input.maintenanceStatus,
      databaseTelemetry: input.provider.telemetry,
    }),
    daemon: Object.freeze({
      runtime: selectDaemonRuntimeQueries(input.daemonRuntime, { infoPath: input.daemonInfoPath }),
    }),
    plantuml: Object.freeze({ configuration }),
    runtime: runtimeManagement.models,
    runtimes: runtimeManagement.runtimes,
    overview: Object.freeze({
      authorization: Object.freeze({ directAuthority: identityAccess.directAuthority }),
      query: overviewQuery,
    }),
  })

  const resourceCatalogRoutes: PostgresqlAppCompositionInput['resourceCatalog'] = Object.freeze({
    agents: Object.freeze({
      ...classicCatalogs.agent,
      authorityFor,
      listDigitalEmployeeTemplates: () =>
        listDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates),
      taskLaunch: taskExecutionProvider.routeLaunch.agent,
    }),
    mcps: Object.freeze({
      queries: mcpCatalog.queries,
      operations: mcpCatalog.operations,
      aclIdentity: mcpCatalog.participants.aclIdentity,
      probeStore: mcpProbeStore,
      authorityFor,
      runtimeTests: { commands: mcpRuntimeTests.commands, queries: mcpRuntimeTests.queries },
      runtimeTestCommandContextFor: mcpRuntimeTests.contexts.command,
      runtimeTestQueryContextFor: mcpRuntimeTests.contexts.query,
      probeRunner: mcpRuntimeTests.probeRunner,
    }),
    plugins: Object.freeze({
      queries: pluginCatalog.queries,
      operations: pluginCatalog.operations,
      authorityFor,
    }),
    skills: Object.freeze({ ...classicCatalogs.skill, authorityFor }),
    repositories: Object.freeze({
      store: core.repositoryWorkspaceStore,
      cached: Object.freeze({
        configuration,
        appHome: input.appHome,
        secretBox: input.secretBox,
      }),
      groups: Object.freeze({ configuration }),
      mirrors: composeRepositoryMirrors({
        store: core.repositoryWorkspaceStore,
        secretBox: input.secretBox,
        appHome: input.appHome,
        ...(input.repositoryRemote === undefined ? {} : { remote: input.repositoryRemote }),
      }),
    }),
    workflows: Object.freeze({
      runtime:
        phase.kind === 'daemon' ? Object.freeze({}) : (input.workflowRuntime ?? Object.freeze({})),
      module: Object.freeze({ ...classicCatalogs.workflow, authorityFor }),
    }),
    workgroups: Object.freeze({
      queries: workgroupCatalog.queries,
      operations: workgroupCatalog.operations,
      resourceIntegrityQueries: classicCatalogs.agentResourceIntegrity.queries,
      authorityFor,
      taskLaunch: taskExecutionProvider.routeLaunch.workgroup,
    }),
    resourcePackages: Object.freeze({
      catalog: resourcePackageCatalog,
      commandContextFor(actor: Actor) {
        const authority = directRequestAuthority(identityAccess.directAuthority, actor)
        const context = identityAccess.contexts.fromAuthority(authority, 'http')
        packageActors.set(context.authority, actor)
        return context
      },
      queryContextFor(actor: Actor) {
        return identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actor),
          'http',
        )
      },
    }),
    workgroupTasks: Object.freeze({ module: workgroupTaskRoom, authorityFor }),
  })

  const taskExecutionRoutes: PostgresqlAppCompositionInput['taskExecution'] = Object.freeze({
    tasks: taskRoutes,
    catalog: taskCatalog,
    archive: Object.freeze({
      configuration,
      taskArchiveMaintenance: taskExecutionProvider.archive,
    }),
    portArtifacts: Object.freeze({
      taskExecutionReadModels: taskExecutionProvider.readModels,
      portArtifacts,
    }),
    clarifyDirective: Object.freeze({
      operations: taskExecutionProvider.routes.clarifyDirective,
    }),
    feedback: Object.freeze({
      collaborationContext: boundCollaborationContext,
      memoryOperations,
    }),
  })

  const sourceControlRoutes: PostgresqlAppCompositionInput['sourceControl'] = Object.freeze({
    codeHosts: Object.freeze({ deps: Object.freeze({}), service: codeHostConnections }),
    repositoryTransportCredentials: Object.freeze({
      runtime: Object.freeze({}),
      route: Object.freeze({
        credentials: repositoryTransport.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      }),
    }),
    worktreeFiles,
  })

  const codeRoutes: PostgresqlAppCompositionInput['code'] = Object.freeze({
    history: codeHistoryQueries,
    capabilityTemplates: Object.freeze({
      codeHistoryQueries,
      capabilityTemplates: capabilityTemplateOperations,
      capabilityTemplateAcl,
    }),
  })

  const collaborationRoutes: PostgresqlAppCompositionInput['collaboration'] = Object.freeze({
    operations: collaborationRouteOperations,
    appHome: input.appHome,
  })

  const memoryRoutes: PostgresqlAppCompositionInput['memory'] = Object.freeze({
    fusion: Object.freeze({
      operations: fusionOperations,
      appHome: input.appHome,
      launchConfiguration: fusionModules.launchConfiguration,
      configPath: input.configPath,
      directAuthority: identityAccess.directAuthority,
    }),
    // RFC-353 T9：技能来源追溯——版本流水来自 resource-catalog，融合记录来自 memory，
    // 拼装归 knowledge-evolution，所以路由挂在 KE 的 inbound 上。
    skillProvenance: Object.freeze({
      skills: classicCatalogs.skill.queries,
      versions: classicCatalogs.skill.versionQueries,
      authorityFor: (actor: Actor) =>
        directOperationAuthority(identityAccess.directAuthority, actor),
      memoryAuthorityFor: (actor: Actor) => ({
        actor,
        authority: directRequestAuthority(identityAccess.directAuthority, actor),
      }),
      listFusedInto: (skillId: string) => memoryCatalog.queries.listFusedInto(skillId),
      filterVisibleMemories: (
        authority: MemoryScopeAuthority,
        rows: readonly FusedIntoSkillMemory[],
      ) => memoryCatalog.queries.filterVisible(authority, rows),
    }),
    memories: Object.freeze({
      catalog: memoryCatalog,
      identityAccess: Object.freeze({
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
      }),
    }),
    distillJobs: Object.freeze({
      memoryDistillCommands: memoryOperations.distillCommands,
      memoryDistillQueries: memoryOperations.distillQueries,
    }),
  })

  const identityRoutes: PostgresqlAppCompositionInput['identity'] = Object.freeze({
    auth: Object.freeze({
      deps: Object.freeze({ configuration }),
      identityAccess,
      bindings: Object.freeze({
        auth: core.authRuntime,
        listIdentitiesForUser: (userId: string) => oidcIdentities.listIdentitiesForUser(userId),
        listTokenAuditForUser: (userId: string) => core.tokenCallAudit.listForUser(userId),
      }),
    }),
    oidcAuth: Object.freeze({
      deps: Object.freeze({ configuration }),
      bindings: Object.freeze({
        auth: core.authRuntime,
        providers: oidcProviders,
        identities: oidcIdentities,
      }),
    }),
    oidc: Object.freeze({ auth: core.authRuntime, providers: oidcProviders }),
    users: Object.freeze({
      auth: Object.freeze({
        auth: core.authRuntime,
        listTokenAudit: () => core.tokenCallAudit.list(),
      }),
      identityAccess: Object.freeze({
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
        operations: identityUserOperations,
      }),
    }),
  })

  const systemRoutes: PostgresqlAppCompositionInput['system'] = Object.freeze({
    maintenanceDisk: core.maintenanceDisk,
    backup: Object.freeze({ operations: core.systemOperations, identityAccess }),
    restore: Object.freeze({ operations: core.systemOperations, identityAccess }),
    databaseMigration: Object.freeze({
      operations: input.databaseMigration.operations,
      identityAccess,
    }),
  })

  const composition: PostgresqlAppCompositionInput = Object.freeze({
    token: input.token,
    configuration,
    authentication: core.httpAuthentication,
    core,
    public: publicRoutes,
    platform: platformRoutes,
    resourceCatalog: resourceCatalogRoutes,
    taskExecution: taskExecutionRoutes,
    integration: integrationRoutes,
    sourceControl: sourceControlRoutes,
    code: codeRoutes,
    digitalDevelopment: digitalDevelopmentRoutes,
    collaboration: collaborationRoutes,
    memory: memoryRoutes,
    intent: intentRoutes,
    identity: identityRoutes,
    system: systemRoutes,
    executionAuthority: input.executionAuthority ?? composeLocalExecutionAuthority(),
  })
  // RFC-359 W3-T4（P0-3 / P0-4）：boot 恢复四步与 SQLite 同一段序列（composition/bootRecovery.ts）——
  // 撤销旧 daemon 的 owner → 收割孤儿 run → 修 runtime session lease → 清算 effect 并释放 / 闭合 owner。
  // 必须在 HTTP 与任何自动续跑之前；此前 PG daemon 从未跑过，重启一次就把上一代任务永久卡在 running。
  const lifecycleSteps: PostgresqlDaemonApplication['lifecycleSteps'] = {
    'process-registrations': async () => {
      registerTerminalWorkspacePrunePolicy(
        composeWebhookTerminalWorkspacePrunePolicy({
          db: input.db,
          enabled: async () => (await configuration.read()).webhookTaskWorkspaceAutoCleanup,
        }),
      )
    },
    'repository-url-sealing': NotApplicable,
    'transport-projections': async () => {
      await reconcileRepositoryTransportConnectionProjections(
        repositoryTransportRepository,
        repositoryTransport.adminConnections,
      )
    },
    'git-credential-lease-cleanup': async () => {
      const removedCredentialLeases = cleanupOrphanedGitCredentialLeases(input.appHome)
      if (removedCredentialLeases > 0) {
        log.info('orphaned git credential leases removed', { count: removedCredentialLeases })
      }
    },
    'daemon-identity': async () => {
      const systemIdentity = await admitDaemonIdentity(identityAccess)
      if (systemIdentity === null) throw new Error('postgresql-daemon-system-identity-not-admitted')
      systemActor = actorOfDirectAuthority(systemIdentity)
    },
    'skill-identity-barrier': async () => {
      const report = await skillCatalogBoot.runIdentityMigrationBarrier()
      if (report.recoveredOperations > 0 || report.removedHusks > 0 || report.migratedSkills > 0) {
        log.info('skill identity migration barrier complete', { ...report })
      }
    },
    'fusion-provenance': async () => {
      const { repairFusionProvenance } =
        await import('@/modules/knowledge-evolution/public/operations')
      const report = await repairFusionProvenance(fusionOperations.persistence)
      if (Object.values(report).some((count) => count > 0)) {
        log.info('fusion provenance repair complete', { ...report })
      }
    },
    'skill-availability-gate': async () => {
      skillCatalogBoot.activateAvailabilityGate()
    },
    'skill-live-files': async () => {
      await skillCatalogBoot.reconcileLiveFiles()
    },
    'task-delete-recovery': async () => {
      const deleteRecovery = await recoverInterruptedTaskDeletes(
        input.db,
        undefined,
        input.taskDeletionEffects,
      )
      if (
        deleteRecovery.completed.length > 0 ||
        deleteRecovery.cleanupPending.length > 0 ||
        deleteRecovery.recoveryRequired.length > 0
      ) {
        log.info('terminal task delete recovery', { ...deleteRecovery })
      }
    },
    'archive-recovery': async () => {
      const archiveRecovery = await taskExecutionProvider.archive.recover({
        archiveDir: Paths.taskArchiveDir,
        runsDir: Paths.runsDir,
        logsDir: Paths.logsDir,
      })
      if (archiveRecovery.promoted.length > 0 || archiveRecovery.discarded.length > 0) {
        log.info('terminal task archive recovery', { ...archiveRecovery })
      }
    },
    'workspace-maintenance-recovery': async () => {
      const workspaceRecovery = await workspaceMaintenance.recover({
        activeTaskIds: [],
        webhookClaims: 'all',
      })
      if (
        workspaceRecovery.completed > 0 ||
        workspaceRecovery.failed > 0 ||
        workspaceRecovery.healed > 0
      ) {
        log.info('terminal workspace maintenance recovery', { ...workspaceRecovery })
      }
    },
    'frame-backfill': async () => {
      const backfill = await runFrameBackfillOnBoot({ db: input.db })
      if (!backfill.skipped) {
        log.info('rfc354 frame backfill completed on boot', {
          tasks: backfill.tasks,
          rowsUpdated: backfill.rowsUpdated,
          roundsUpdated: backfill.roundsUpdated,
          unreadableTasks: backfill.unreadableTasks.length,
          unresolvedRows: backfill.unresolvedRows,
        })
      }
    },
    'scheduled-payload-heal': async () => {
      const { healScheduledLaunchPayloads } = await import('@/services/scheduledTasks')
      const healed = await healScheduledLaunchPayloads(scheduledTaskRuntime.operations)
      if (healed.converted > 0 || healed.disabled > 0) {
        log.info('scheduled launch payloads healed', healed)
      }
    },
    'fusion-decision-recovery': async () => {
      const { recoverFusionDecisions } =
        await import('@/modules/knowledge-evolution/public/operations')
      const r = await recoverFusionDecisions(fusionOperations.persistence)
      if (r.rolledForward + r.rolledBack + r.rejectFailed > 0) {
        log.info('fusion decision recovery on boot', { ...r })
      }
    },
    'fusion-resource-seed': async () => {
      const { seedFusionResources } =
        await import('@/modules/knowledge-evolution/public/operations')
      await seedFusionResources(fusionOperations.persistence)
    },
    'demo-seed': async () => {
      const { seedDemoContent } = await import('@/services/demoSeed')
      const result = await seedDemoContent({
        resourceCatalog: composeDemoResourceCatalogSeedParticipant(input.db),
        codeCapability: composeCodeCapabilityDemoSeedParticipant(input.db),
      })
      if (result.seeded) log.info('demo content seeded (delete it and it stays deleted)')
    },
    'event-catalog': async () => {
      await eventCenter.initialize()
    },
    'employee-agent-templates': async () => {
      await ensureDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates)
    },
    'employee-tool-catalog': async () => {
      await digitalEmployeePlatformTools.load()
    },
    'employee-authoring-ready': async () => {
      await digitalEmployee.maintenance.ready()
    },
    'employee-writer-state': async () => {
      await employeeWriterCutover.activate()
    },
    'task-execution-recovery': async () => {
      await runTaskExecutionBootRecovery({
        recoveryEffects: selectLocalBootExecutionRecoveryFactory(input.bootExecutionRecovery),
        persistence: taskExecutionPersistence,
        runtimeSessionLeases,
        lockProof:
          input.daemonStartupLease === undefined
            ? createDaemonLockProof({
                lockPath: input.lockPath,
                lockPid: process.pid,
                daemonGeneration: input.provider.runtime.generationId,
              })
            : createDaemonRecoveryAuthorityProof(
                await readDaemonStartupRecoveryAuthority(
                  input.daemonStartupLease,
                  input.provider.runtime.generationId,
                ),
              ),
        codeHostProbe: (descriptor) =>
          probeCodeHostMutation({
            descriptor,
            resolveConnection: (provider) => codeHostConnections.resolve(provider),
          }),
        log,
      })
    },
    'observation-interrupt': async () => {
      const interruptedCalls = await observationCalls.repairInterrupted(Date.now())
      if (interruptedCalls > 0)
        log.info('observation calls interrupted', { count: interruptedCalls })
    },
    'mr-terminal-reconcile': async () => {
      await webhookTerminalControl.reconcileOnBoot()
    },
    'webhook-delivery-recovery': async () => {
      const recoveredDeliveries = await recoverInterruptedDeliveries(
        integrationModules.webhookDeliveryPersistence,
      )
      if (recoveredDeliveries > 0) {
        log.info('webhook deliveries marked interrupted', { count: recoveredDeliveries })
      }
    },
    'legacy-mission-recovery': NotApplicable,
    'employee-upgrade-settlement': async () => {
      await digitalEmployee.maintenance.settleAutomaticUpgrades()
    },
    'hosted-targeted-resume': async () => {
      const recoveredTaskIds = input.recoveredExecutionTaskIds?.() ?? []
      if (recoveredTaskIds.length > 0) {
        await taskExecutionProvider.autoResume.run({
          taskIds: recoveredTaskIds,
          breaker: {
            maxPerWindow: input.config.maxAutoRecoveriesPerWindow,
            windowMs: input.config.autoRecoveryWindowMs,
          },
        })
      }
    },
    'resource-reverify': async () => {
      const bf = await skillCatalogBoot.backfillLegacyVersions()
      const r = await skillCatalogBoot.reverifySnapshots()
      log.info('boot snapshot reverify', {
        ...r,
        legacyBackfilled: bf.backfilled,
        husksRemoved: bf.husksRemoved,
      })
    },
    'bootstrap-admin-hint': async () => {
      if (await core.authRuntime.isBootstrapRequired())
        log.info(
          'first multi-user run? create your admin via `agent-workflow user create --admin --username <name>`',
        )
    },
  }
  if (phase.kind === 'unstarted') {
    await (lifecycleSteps['daemon-identity'] as () => Promise<void>)()
    await eventCenter.initialize()
    await digitalEmployeePlatformTools.load()
    await phase.scope.trackReady(digitalEmployee.maintenance.ready())
  }
  const app = createComposedApp(composePostgresqlAppDeps(composition))
  const webSocket = buildWebSocketAdapter({
    realtime: core.realtime,
    identityAccess: core.identityAccess,
  })
  const runtime: PostgresqlDaemonApplicationRuntime = Object.freeze({
    taskExecution: taskExecutionProvider,
    taskExecutionModules,
    collaborationContext: boundCollaborationContext,
    scheduledTasks: scheduledTaskRuntime,
    scheduledTaskIdentityAccess: integrationIdentityAccess,
    memory: memoryOperations,
    developmentAutomation,
    digitalEmployee,
    employeeWriterCutover,
    archivedNodeEvents: input.archivedNodeEvents,
    crewStationEvents: integrationModules.crewStationEvents,
    eventCenter,
    fusion: fusionOperations,
    resourceLimits: resourceLimitOperations,
    taskIdleTimeout: taskIdleTimeoutOperations,
    mcpRuntimeTests,
    webhookTerminalControl,
    workspaceMaintenance,
    intentMaintenance,
    resourcePackageActivity: resourcePackageAtomicApply,
    async resumeIntentSessions(sessionIds: readonly string[], config: Config) {
      if (sessionIds.length === 0) return
      await resumeQueuedIntentWorkingSets(
        { ...intentDispatchDeps, configSnapshot: config },
        sessionIds,
      )
    },
    // RFC-370 hosted acceptance: claiming while this process's parked driver
    // still drained its admitted work was an owner conflict that the worker
    // retried (and warned about) every second for as long as that work ran.
    // SQLite defers behind `awaitTaskDriverIdle` the same way.
    driveHumanGateContinuation: createGateContinuationDriver({
      isDriving: (taskId) => taskExecutionProvider.executionModule.runtimeRegistry.hasTask(taskId),
      coordinator: taskDriveCoordinator,
    }),
  })
  return Object.freeze({ core, app, webSocket, runtime, lifecycleSteps })
}
