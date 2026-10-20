import {
  composeDaemonTaskExecutionModules,
  type DaemonTaskExecutionModules,
} from '@/cli/daemonModules/taskExecution'
import { DAEMON_TASK_EXECUTION_ADAPTERS } from '@/cli/daemonModules/adapters'
import { finishClaimedWebhookWorkspacePrune, materializingSpaces } from '@/services/gc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import {
  composeDaemonScheduledTaskModules,
  type DaemonScheduledTaskModules,
} from '@/cli/daemonModules/scheduledTasks'
import {
  composeDaemonIntegrationModules,
  type DaemonIntegrationModules,
} from '@/cli/daemonModules/integration'
import { composeDaemonFusionModules, type DaemonFusionModules } from '@/cli/daemonModules/fusion'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import {
  DAEMON_PROVIDER_CORE_ADAPTERS,
  standaloneModuleAdapters,
} from '@/cli/daemonModules/adapters'
import { composeDaemonMemoryModules, type DaemonMemoryModules } from '@/cli/daemonModules/memory'
import {
  composeDaemonObservationModules,
  type DaemonObservationModules,
} from '@/cli/daemonModules/observation'
import {
  composeDaemonProviderCore,
  type DaemonProviderCore,
  type SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'
import {
  composeDaemonRepositoryCredentials,
  type DaemonRepositoryCredentials,
} from '@/cli/daemonModules/repositoryCredentials'
import {
  composeDaemonResourceCatalogModules,
  type DaemonResourceCatalogModules,
} from '@/cli/daemonModules/resourceCatalog'
import { composeDaemonRealtimePolicy } from '@/cli/daemonRealtimePolicy'
import { batchOwnerUserId } from '@/services/repoBatchImport'
import { redactEventPayload } from '@/services/tokenRedaction'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import { composeClarifyFollowupGenerator } from '@/modules/task-execution/composition/clarifyFollowupGenerator'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type {
  ApprovalAdapterBinding,
  PipelineAdapterBinding,
  RequirementAdapterBinding,
} from '@/modules/integration/public/participants'
import { createLocalDevelopmentAdapterEffects } from '@/modules/integration/composition/developmentAdapterProgram'
import type {
  EvidenceStagingFactory,
  PipelineStagingFactories,
} from '@/modules/development-automation/public/types'
import {
  createLocalEvidenceArtifactPort,
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
  createFileEvidenceDocumentCommands,
} from '@/modules/development-automation/composition/evidenceStaging'
import { assertEvidenceStagingFactory } from '@/modules/development-automation/public/participants'
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
import type {
  RepositoryCandidateEffectsFactory,
  createRepositoryPublicationTransport,
} from '@/modules/source-control/composition'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import {
  composePortArtifactOperations,
  selectPortArtifactOperations,
} from '@/modules/task-execution/composition/portArtifacts'
import type {
  PortArtifactContentEffects,
  PortArtifactOperations,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import { composeTaskRuntimeInventoryContent } from '@/modules/task-execution/composition/taskRuntimeInventoryContent'
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
  composeRunObservation,
  type RunObservation,
} from '@/modules/run-observability/composition/runObservation'
import type { RuntimeProfileConfigurationCommands } from '@/modules/runtime-management/public/commands'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import type { HttpAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import {
  composeLocalHttpAuthentication,
  composeHttpAuthenticationMiddleware,
} from '@/modules/identity-access/composition/authentication'
import { composeWebhookIngressTransport } from '@/modules/integration/composition/webhookIngress'
import type {
  ApplicationConfigurationQueries,
  DaemonRuntimeQueries,
} from '@/modules/system-operations/public/queries'
import { selectDaemonRuntimeQueries } from '@/modules/system-operations/composition/daemonHostLifecycle'
import { bindExecutionAvailability } from '@/platform/http/executionAvailability'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import { createExecutionContractProgramFixtureAdapter } from '@/modules/task-execution/composition/executionContractFixture'
import { createArtifactProgramToolSource } from '@/modules/task-execution/composition/programTools'
import { createExecutionContractResourceAdapter } from '@/modules/resource-catalog/composition/executionContractResource'
// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { Hono } from 'hono'
import type {
  DatabaseRuntimeTelemetry,
  MaintenanceStatus,
  ResourceAcl,
  UpdateResourceAclBody,
  WorkflowRevision,
} from '@agent-workflow/shared'
import { join } from 'node:path'
import { actorOf, tryActorOf, type Actor } from '@/auth/actor'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { TokenCallAuditParticipant } from '@/auth/application/tokenCallAudit'
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import type { SecretBox } from '@/auth/secretBox'
import { actorOfDirectAuthority, admitDaemonIdentity } from '@/auth/session'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import { takeDeleteSnapshot } from '@/services/tokenAudit'
import { assertRouteMetaCoverage, registerRoute } from '@/routes/registry'
import type { DbClient } from '@/db/client'
import type {
  BuildScheduleLaunch,
  IntegrationTriggerResourceBinding,
} from '@/services/scheduledTasks'
import type { SmokeOptions, SmokeResult } from '@/services/runtimeSmoke'
import { getEmbeddedFrontendResponse, IS_EMBEDDED, type FrontendDeploymentMode } from '@/embed'
import { mountMcpTransport } from '@/mcp/server'
import { assertOperationCatalogClosed, registerOperationAlias } from '@/platform/operations/catalog'
import { createBoundOperationInvoker } from '@/platform/operations/boundOperationInvoker'
import {
  directMcpOperationAuthority,
  directOperationAuthority,
  directRequestAuthority,
} from '@/routes/operationAuthority'
import { mountAgentRoutes } from '@/routes/agents'
import { mountAuthRoutes } from '@/routes/auth'
import { mountBackupRoutes } from '@/routes/backup'
import { mountDatabaseMigrationRoutes } from '@/routes/databaseMigrations'
import { mountRestoreRoutes } from '@/routes/restore'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { mountRepoGroupRoutes } from '@/routes/repoGroups'
import { mountConfigRoutes, type ConfigConcurrencyHotApplyCommand } from '@/routes/config'
import { mountDaemonRoutes } from '@/routes/daemon'
import { mountDocsRoutes, mountWellKnownRoutes } from '@/routes/docs'
import { mountHealthRoutes } from '@/routes/health'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import { type WebhookDispatcher } from '@/services/webhook/dispatcherTypes'

import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import {
  createEventAutomationDelegatedContextBinding,
  type IdentityAccessModule,
  type IdentityAccessRuntime,
} from '@/modules/identity-access/composition'

import type { CommandContext } from '@/modules/identity-access/public/participants'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import type { AgentResourceIntegrityComposition } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import type { composeMcpProbeStore } from '@/modules/resource-catalog/composition/mcpProbeStore'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import {
  composeWorkgroupTaskRoom,
  composeWorkgroupTaskRoomActiveUsers,
  composeWorkgroupTaskRoomDynamicWorkflow,
} from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import type { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { type ProviderResourceCatalogComposition } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { type ComposedResourcePackageCatalog } from '@/modules/resource-catalog/composition/resourcePackageOperations'
import type { updateResourceAcl } from '@/modules/resource-catalog/composition/resourceAcl'
import { assertNameUnchangedForEditor } from '@/modules/resource-catalog/application/resourceAccess'
import { resourceAclAudienceAuthority } from '@/modules/resource-catalog/domain/resourceAccess'

import type { TaskExecutionResourceBinding } from '@/services/execution/taskExecutionResources'
import type {
  AgentCatalogModule,
  McpCatalogModule,
  PluginCatalogModule,
  SkillCatalogModule,
  WorkflowCatalogModule,
  WorkgroupCatalogModule,
} from '@/modules/resource-catalog/public/operations'
import {
  executionStatusOf,
  type SystemOperationsModule,
} from '@/modules/system-operations/composition'
import type { MaintenanceDiskOperations } from '@/modules/system-operations/public/operations'
import type { DatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { SYSTEM_OPERATION_ALIASES } from '@/modules/system-operations/public/operations'
import type { HealthDatabaseReadModel } from '@/modules/system-operations/public/queries'
import {
  composeOidcIdentityOperations,
  composeOwnerIdentityQueries,
} from '@/modules/identity-access/composition/providerOperations'
import type { IdentityUserOperations } from '@/modules/identity-access/public/operations'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import { createOidcProvidersService } from '@/services/oidcProviders'
import { type LocalMcpDiagnosticsCompositionInput as McpDiagnosticsCompositionInput } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { McpDiagnosticsRuntime } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import { mountMcpRoutes } from '@/routes/mcps'
import { mountMemoryRoutes } from '@/routes/memories'
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'
import type { composeMemoryCatalogOperations } from '@/modules/memory/composition'

import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import {
  composeRepositoryMirrors,
  createFileWorkspaceContentEffects,
  createWorkspaceContentScope,
  type EmployeeCaseWorkspaceEffectsFactory,
  type RepositoryMirrors,
  type WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
  type WorkspacePresenceQueries,
} from '@/modules/source-control/public/queries'
import type { MemoryOperations } from '@/modules/memory/public/operations'
import type { MemoryDistillCommands } from '@/modules/memory/public/commands'
import type { MemoryDistillQueries } from '@/modules/memory/public/queries'
import type { ResourcePackageApplyActivityQuery } from '@/modules/resource-catalog/public/queries'
import {
  readCommittedReviewArtifactBody,
  resolveCollaborationTaskAccess,
} from '@/modules/collaboration/public/queries'
import { mountTaskFeedbackRoutes } from '@/routes/taskFeedback'
import { mountOverviewRoutes, type OverviewRouteQuery } from '@/routes/overview'
import { composeResourceCatalogOverviewQuery } from '@/modules/resource-catalog/composition/resourceCatalogOverview'
import { composeSystemOverviewQuery } from '@/modules/system-operations/composition/overview'
import { mountOidcRoutes } from '@/routes/oidc'
import { mountOidcAuthRoutes } from '@/routes/oidc-auth'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountPluginRoutes } from '@/routes/plugins'
import { mountUserRoutes } from '@/routes/users'
import { mountRepoRoutes } from '@/routes/repos'
import { composeRuntimeProbeConfigFence } from '@/modules/runtime-management/composition/runtimeManagement'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import {
  mountRuntimeRoutes,
  mountRuntimesRoutes,
} from '@/modules/runtime-management/composition/runtimeRoutes'
import type {
  RuntimeModelQueries,
  RuntimeProfileQueries,
} from '@/modules/runtime-management/public/queries'
import type {
  RuntimeProfileCommands,
  RuntimeDiagnosticCommands,
} from '@/modules/runtime-management/public/commands'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import { mountSkillRoutes } from '@/routes/skills'
import { mountClarifyRoutes } from '@/routes/clarify'
import { mountTaskQuestionRoutes } from '@/routes/taskQuestions'
import { mountTaskClarifyDirectiveRoutes } from '@/routes/taskClarifyDirective'
import { mountFusionRoutes } from '@/modules/knowledge-evolution/inbound/fusionRoutes'
import { mountSkillProvenanceRoutes } from '@/modules/knowledge-evolution/inbound/skillProvenanceRoutes'
import {
  mountIntentSessionRoutes,
  type IntentSessionRouteDependencies,
} from '@/modules/intent/inbound/intentSessionRoutes'
import type { IntentApplyActivitySource } from '@/modules/intent/composition/maintenance'
import {
  composeIntentApplyOperations,
  createIntentSessionWsPublisher,
} from '@/modules/intent/composition/apply'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '@/modules/intent/composition/auxiliaryQueries'
import { composeIntentPlatformInventoryParticipant } from '@/modules/intent/composition/platformInventory'
import { composeIntentPersistence } from '@/modules/intent/composition/persistence'
import { composeIntentContextResourceAuthorizationFactory } from '@/modules/resource-catalog/composition/intentContextAuthorization'
import type { IntentApplyOperations } from '@/modules/intent/public/operations'
import { composeIntentResourceCatalogFor } from '@/modules/intent/application/resourceCatalog'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { mountReviewRoutes } from '@/routes/reviews'
import { mountMaintenanceDiskRoutes } from '@/routes/maintenanceDisk'
import { mountMaintenanceRoutes } from '@/routes/maintenance'
import { mountTaskArchiveRoutes } from '@/routes/taskArchive'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountTaskCatalogRoutes } from '@/routes/taskCatalog'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountCodeHostRoutes } from '@/routes/codeHosts'
import { mountAccountRepositoryTransportCredentialRoutes } from '@/routes/accountRepositoryTransportCredentials'
import {
  mountCapabilityTemplateRoutes,
  type CapabilityTemplateRouteDeps,
} from '@/routes/capabilityTemplates'
import { mountDevelopmentConfigRoutes } from '@/routes/developmentConfig'
import { mountDevelopmentMissionRoutes } from '@/routes/developmentMissions'
import {
  mountDigitalEmployeeRoutes,
  type DigitalEmployeeAclResourceType,
  type DigitalEmployeeRoutePersistence,
} from '@/routes/digitalEmployees'
import { mountEventCenterRoutes } from '@/routes/eventCenter'
import { mountExecutionContractRoutes } from '@/routes/executionContracts'
import { mountMissionInputUploadRoutes } from '@/routes/missionInputUploads'
import { mountCodeRoutes, type CodeHistoryRouteQueries } from '@/routes/code'
import { mountWebhookEndpointRoutes } from '@/routes/webhookEndpoints'
import { mountWebhookTriggerRoutes } from '@/routes/webhookTriggers'
import { mountWebhookDeliveryRoutes } from '@/routes/webhookDeliveries'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorkgroupRoutes } from '@/routes/workgroups'
import { registerResourcePackageRoutes } from '@/routes/resourcePackages'
import { Paths } from '@/util/paths'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes, type WorktreeFilesRouteDeps } from '@/routes/worktree-files'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import {
  composeDigitalEmployee,
  composeDigitalEmployeePlatformInventoryParticipant,
  composeDigitalEmployeeTaskCatalogSource,
  composeDigitalEmployeeWriterCutoverFor,
  createEmployeeInputArtifactStore,
} from '@/modules/digital-employee/composition'

import type { DigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/public/participants'
import type {
  DigitalEmployeePlatformToolCatalogParticipant,
  EmployeeCaseDetailProjectionParticipant,
} from '@/modules/digital-employee/public/types'
import {
  developmentExecutionContractRegistrations,
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDevelopmentMissionOperations,
  createLegacyMissionAdmissionsEnabledQuery,
} from '@/modules/development-automation/composition/missionOperations'
import {
  composeMissionInputUploadOperations,
  type MissionInputBlobPersistence,
} from '@/modules/development-automation/composition/missionInputUploads'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { composeLegacyCodeReadProviders } from '@/modules/code-capability/composition/legacyCodeReads'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/composition/codeReviewArtifacts'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/composition/repositoryRevisionContent'
import { composeDevelopmentActivityOperations } from '@/modules/development-automation/composition/activityOperations'
import type {
  DevelopmentConfigOperations,
  DevelopmentMissionOperations,
} from '@/modules/development-automation/public/operations'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import {
  type EventCenterModule,
  type CustomObserverProgramFactory,
} from '@/modules/event-center/composition'

import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeReactionExecutionProvider,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import type { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionRuntime'
import {
  createDrizzleTaskArchiveMaintenanceCommand,
  type TaskArchiveContentBinding,
  type TaskArchiveMaintenanceCommand,
} from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type { createSqliteTaskRouteLaunchOperations } from '@/modules/task-execution/composition/taskRouteLaunch'
import type { RuntimeRegistryOperations } from '@/modules/runtime-management/composition/runtimeRegistry'
import { type SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import type {
  NodeRunPromptContentEffects,
  NodeRunPromptOperations,
  TaskDeletionEffects,
  TaskExecutionReadModels,
} from '@/modules/task-execution/public/types'
import {
  composeNodeRunPromptOperations,
  selectNodeRunPromptOperations,
} from '@/modules/task-execution/composition/nodeRunPrompts'
import {
  createSqliteCollaborationTaskAccessPort,
  planMembersReplacement,
} from '@/modules/collaboration/composition'
import { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'

import { createPostgresqlResourcePackageExecutionAdapter } from '@/services/resourcePackage/executionAdapter'
import { createResourcePackagePluginInstaller } from '@/services/resourcePackage/pluginInstallerAdapter'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
  type ResourcePackageSkillArtifactOwner,
  type ResourcePackagePluginArtifactOwner,
  type SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { resizeAllNodePools } from '@/services/processNodeConcurrency'
import { resizeAllTaskFanoutSems } from '@/services/taskFanoutPools'
import { setChildTaskBudgetCapacity } from '@/services/execution/childBudget'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { listDigitalEmployeeAgentTemplates } from '@/services/digitalEmployeeAgentTemplates'
import {
  composeDevelopmentEmployeeWorkspace,
  createDevelopmentEmployeeCaseWorkspaceDetailReader,
} from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { composeDevelopmentEmployeeCaseDetailProjection } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import {
  composeDevelopmentAutomation,
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
  type AttemptContextStorePort,
  composeDevelopmentAdmissionLookup,
  createDevelopmentMissionExecutionTerminalObserver,
  type DevelopmentAdmissionLookup,
  type DevelopmentAutomationModule,
} from '@/modules/development-automation/composition'

import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import {
  buildDevelopmentDeliveryDeps,
  buildDevelopmentMrFactsDeps,
  buildDevelopmentPipelineDeps,
} from '@/services/developmentDeliveryDeps'

import type { composeDevelopmentAdapterConfigOperationsFor } from '@/modules/integration/composition/developmentAdapterConfigOperations'
import { composeSelectedRequirementSourceRunnerFor } from '@/modules/integration/composition/requirementSource'

import { type WebhookIngressPersistence } from '@/modules/integration/composition/webhookIngress'

import type { DigitalEmployeeWorkStartPort } from '@/modules/integration/public/participants'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { canManageCaseMembers } from '@/services/employeeCaseMembers'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  type RepositoryTransportCredentialModule,
  type RepositoryTransportCredentialRepository,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { composeAgentActionExecution } from '@/modules/task-execution/composition/agentActionExecution'
import { composeScriptActionExecution } from '@/modules/task-execution/composition/scriptActionExecution'

import { createFileFusionWorkspaceEffects } from '@/modules/source-control/composition'
import { composeIntentWorkflowGraphValidation } from '@/modules/intent/composition/graphValidation'

export type {
  DaemonProviderCore,
  SelectedDaemonProviderCore,
} from '@/cli/daemonModules/providerCore'

/**
 * Narrow in-process dependency seams for route tests that exercise diagnostics
 * with deterministic fixture executables. Production startup never supplies
 * these; there is no config, environment, or HTTP switch that can select them.
 */
export interface RuntimeDiagnosticTestDependencies {
  smokeRuntime(options: SmokeOptions): Promise<SmokeResult>
  /**
   * Deterministic finalization seam for the runtime-probe/config fence race.
   * Production never supplies it.
   */
  beforeRuntimeProbeCache?(): void | Promise<void>
  /**
   * RFC-284 T26 — per-row `--version` probe timeout for /api/runtimes/status.
   * Test-only injection（取代已删除的同名 env 通道，见 docs/env-flags.md
   * §已删除）；production keeps the 5s default.
   */
  probeTimeoutMsForTest?: number
}

export interface AppDeps {
  repositoryCredentials?: DaemonRepositoryCredentials
  resourceCatalogModules?: DaemonResourceCatalogModules
  observationModules?: DaemonObservationModules
  memoryModules?: DaemonMemoryModules
  taskExecutionModules?: DaemonTaskExecutionModules<'sqlite'>
  repositoryPreparationEffects?: NonNullable<
    Parameters<typeof composeDaemonTaskExecutionModules>[0]['selection']['preparationEffects']
  >
  scratchWorkspaceEffects?: NonNullable<
    Parameters<typeof composeDaemonTaskExecutionModules>[0]['selection']['scratchEffects']
  >
  scheduledTaskModules?: DaemonScheduledTaskModules
  integrationModules?: DaemonIntegrationModules
  fusionModules?: DaemonFusionModules
  /** The same complete store selection serves skill editing and boot recovery. */
  skillContent?: SkillContentBinding
  employeePrograms?: ProgramArtifactPort
  employeeInputArtifacts?: EmployeeInputArtifactPort
  missionInputBlobs?: MissionInputBlobPersistence
  pluginInstaller?: PluginInstallerPort
  beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  archivedNodeEvents?: TaskArchivedEventsReader
  crewStationEvents?: CrewStationEventIngress
  intentArtifacts?: IntentArtifactSelection
  evidenceArtifacts?: EvidenceArtifactPort
  resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  resourcePackageSkillContent?: SkillPackageContentReader
  workspaceContent?: WorkspaceContentEffectsFactory
  workspaceUploads?: WorkspaceUploadContentFactory
  isolationWorkspaces?: IsolationWorkspaceFactory
  repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  repositoryBaselines?: RepositoryBaselineEffectsFactory
  verificationCommands?: VerificationCommandEffectsFactory
  customObserverPrograms?: CustomObserverProgramFactory
  automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  actionWorkspaceEffects?: ActionWorkspaceEffects
  conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  taskDeletionEffects?: TaskDeletionEffects
  nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  nodeRunPrompts?: NodeRunPromptOperations
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  portArtifacts?: PortArtifactOperations
  taskRunSelection?: TaskRunRootSelection
  developmentPurposes?: DevelopmentPurposeSelection
  runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  developmentPurposeRoot?: SelectedDevelopmentPurposeRoot
  workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  evidenceRead?: EvidenceReadBinding
  evidenceDocumentCommands?: EvidenceDocumentCommands
  attemptContext?: AttemptContextStorePort
  /** Selected archive store for standalone HTTP composition. */
  taskArchive?: TaskArchiveContentBinding
  /** Daemon HTTP reuses the exact archive command used by boot recovery. */
  taskArchiveMaintenance?: TaskArchiveMaintenanceCommand
  /** SC presence facts selected once for root/child/continuation resume. */
  workspacePresence?: WorkspacePresenceQueries
  workspaceReads?: RepositoryWorkspaceReadQueries
  /**
   * RFC-349 bootstrap-selected provider core shared by HTTP, MCP, WebSocket
   * and background services. Individual fields below remain test seams; the
   * daemon supplies this aggregate so every consumer observes one provider.
   */
  providerCore?: DaemonProviderCore
  /** One daemon-scoped execution driver composed by server/CLI bootstrap. */
  schedulerDriver?: SchedulerDriverPort
  /** Read projections composed with the same task-execution runtime. */
  taskExecutionReadModels?: TaskExecutionReadModels
  /** Provider-selected Agent/Workgroup launch operations shared with route mounts. */
  taskRouteLaunch?: ReturnType<typeof createSqliteTaskRouteLaunchOperations>
  /**
   * RFC-321 bootstrap publication transport. Task launch/continuation topologies
   * reuse its GitHub/GitLab endpoint discovery instead of rebuilding a
   * key-file-only transport that can only apply URL rules.
   */
  repositoryPublicationTransport?: ReturnType<typeof createRepositoryPublicationTransport>
  /**
   * RFC-344 daemon-scoped development automation participant. The CLI injects
   * the same instance used by recovery and wake sweeps so REST and MCP cannot
   * create an independent orchestration root.
   */
  developmentAutomation?: DevelopmentAutomationModule
  /**
   * RFC-317 T54 —— RFC-321 传输凭据模块，**由 bootstrap 装配**后传进来。
   *
   * RFC-317 把它从当时会被 REST/MCP 两次调用的 `mountApiRoutes` 上移到
   * bootstrap。RFC-344 已删除第二套 MCP Hono；继续由 bootstrap 持有，避免
   * route mount 重新成为 module composition owner。
   *
   * `undefined`（直接调 `mountApiRoutes` 的调用方）与 `null`（没有 secretBox）
   * 都表示「没有传输凭据模块」。
   */
  repositoryTransport?: RepositoryTransportCredentialModule
  /** RFC-349 bootstrap-selected transport credential persistence. */
  repositoryTransportCredentialRepository?: RepositoryTransportCredentialRepository
  /** RFC-349 bootstrap-selected source-control workspace persistence. */
  repositoryWorkspaceStore?: RepositoryWorkspaceStore
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /** Selected live query shared by configuration consumers in this application. */
  configuration?: ApplicationConfigurationQueries
  /** One selected storage instance owns Settings writes and live reads. */
  applicationConfiguration?: ApplicationConfigurationBinding
  /**
   * Root used for immutable digital-employee program artifacts and isolated
   * contract fixtures. Production uses Paths.root; tests may pin a dedicated
   * directory without touching the process-global Paths singleton.
   */
  appHome?: string
  /**
   * Absolute path to the daemon run-info file (host/port/url the daemon is
   * actually bound to). Optional — defaults to `Paths.daemonInfo` in the route;
   * tests inject a temp file. Read by GET /api/daemon.
   */
  daemonInfoPath?: string
  /** Selected current host facts; shared with startup readiness publication. */
  daemonRuntime?: DaemonRuntimeQueries
  /** RFC-370 v2 H7: bootstrap-selected execution authority; absent means standalone. */
  executionAuthority?: ExecutionAuthorityPort
  /**
   * Legacy-compatible health field. RFC-226 production startup never probes
   * optional OpenCode and therefore passes null; tests may inject a string to
   * verify compatibility with older health payloads.
   */
  opencodeVersion: string | null
  /** DB schema version (count of applied migrations). */
  dbVersion: number
  /** Legacy direct-test SQLite handle used by the compatibility wrapper. */
  db: DbClient
  /** RFC-349 bootstrap-selected authentication runtime. */
  authRuntime?: AuthRuntime
  /** RFC-349 bootstrap-selected REST/MCP/maintenance audit participant. */
  tokenCallAudit?: TokenCallAuditParticipant
  /** RFC-349 bootstrap-selected liveness projection. */
  healthDatabase?: HealthDatabaseReadModel
  /** RFC-349 bootstrap-selected backup/restore administration module. */
  systemOperations?: SystemOperationsModule
  /** RFC-349 bootstrap-selected webhook ingress persistence. */
  webhookIngressPersistence?: WebhookIngressPersistence
  /** RFC-349 bootstrap-selected runtime registry. */
  runtimeRegistry?: RuntimeRegistryOperations
  /** Daemon-scoped live concurrency mutation composed by bootstrap. */
  configConcurrencyHotApply?: ConfigConcurrencyHotApplyCommand
  /**
   * RFC-349 provider-neutral execution-contract projection. Production
   * bootstrap injects the selected provider adapter once so HTTP and the
   * Digital Employee worker share the same application participant. Direct
   * createApp tests may omit it and retain the SQLite compatibility path.
   */
  executionContracts?: ReturnType<typeof composeExecutionContract>
  /**
   * RFC-349 provider-neutral code-history projections. Production bootstrap
   * injects the selected provider aggregate once; direct createApp tests may
   * omit it and retain the SQLite compatibility composition.
   */
  codeHistoryQueries?: CodeHistoryRouteQueries
  /** Branded selected-provider Agent template catalog shared with the employee OS. */
  digitalEmployeeAgentTemplates?: DigitalEmployeeAgentTemplateCatalogParticipant
  /**
   * Completed immutable platform-tool projection. Production composes this
   * asynchronously before HTTP assembly; the synchronous direct-test wrapper
   * may omit it and exercises the empty platform catalog explicitly.
   */
  digitalEmployeePlatformTools?: DigitalEmployeePlatformToolCatalogParticipant
  /** RFC-349 bootstrap-selected admission lookup shared by reconcile and HTTP launch. */
  developmentAdmissionLookup?: DevelopmentAdmissionLookup
  /** RFC-349 provider-neutral distillation monitoring queries. */
  memoryDistillQueries?: MemoryDistillQueries
  /** RFC-349 bootstrap-selected memory command/query/worker aggregate. */
  memoryOperations?: MemoryOperations
  /**
   * RFC-349 bootstrap-owned database migration application. Production and
   * contract harnesses inject one composition root with their own admission
   * and durable paths; route mounting never constructs provider mechanisms.
   */
  databaseMigration?: DatabaseMigrationModule
  /** RFC-347 bootstrap-owned authority/presence runtime shared by HTTP/MCP/WS. */
  identityAccess?: IdentityAccessRuntime & {
    readonly taskExecutionResources?: TaskExecutionResourceBinding
  }
  /** RFC-340 bootstrap-owned review access/config context shared by REST and MCP dispatch. */
  collaborationContext?: CollaborationRouteContext
  /** RFC-338: indexed/live projection from the off-thread maintenance owner. */
  maintenanceStatus?: () => MaintenanceStatus
  /** RFC-349: selected-provider mechanism telemetry, kept separate from request latency. */
  databaseTelemetry?: () => DatabaseRuntimeTelemetry
  /**
   * RFC-036 — AES-256-GCM seal/unseal helper.
   *
   * RFC-359 AC-1（plan §5gt）：**必填**。此前是可选的，于是这棵组合树里长出 11 处
   * `deps.secretBox === undefined ? … : …` 的容忍分支，以及它们下游一串可空值
   * （`oidcProviders` / `codeHostConnections` / `webhookEndpointService` /
   * `resourcePackageBinding` / `repositoryTransport`）。
   *
   * 那些分支**在生产里一条都到不了**：`cli/start.ts:1480` 在**选 provider 之前**就
   * 无条件 `createSecretBox(...)`（源码注释原话：needed by either selected composition），
   * 两个引擎的真实部署都必定带它。可选性唯一的服务对象是「省事不传的测试」，
   * 代价却是 PostgreSQL 根要求必填、SQLite 根不要求——一处纯粹的装配签名不对称
   * （`rfc221-login-policy-routes` 的注释早就把这条记成「正解是收成必填」）。
   */
  secretBox: SecretBox
  /**
   * RFC-257 — async webhook dispatch (the T6 fan-out engine). The public
   * ingress route refuses to mount without BOTH this and secretBox (same
   * self-skip discipline as OIDC) so a partially-wired app never exposes a
   * guaranteed-500 public route.
   */
  webhookDispatcher?: WebhookDispatcher
  /** RFC-303 durable launch guard + terminal effect worker. */
  webhookTerminalControl?: MrTerminalControl
  /**
   * RFC-310 OS: production shares this durable Event Center composition with
   * webhook ingress so passive code-host hints can wake the subscribed poller.
   * Route tests may omit it and use the local DB-backed composition below.
   */
  digitalEmployeeEventCenter?: EventCenterModule
  /**
   * Type-owned Case-detail projection, composed once at bootstrap so the REST
   * and MCP route tables share the same participant.
   */
  digitalEmployeeCaseDetailProjection?: EmployeeCaseDetailProjectionParticipant
  /** Bun-dev only: serve the current type-package draft without rewriting its frozen DB row. */
  digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
  /**
   * RFC-269 — outbound `fetch` seam for code-host calls (connection tests and
   * the call-node executor). Production omits it and the real `fetch` is used;
   * tests inject a stub so no suite ever depends on reaching gitlab.com.
   */
  codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
  /**
   * RFC-159 — override the scheduled-task run-now launch closure. Production
   * omits it (the route builds the real one from db + configPath); tests inject
   * a stub so POST /:id/run-now doesn't spawn a real opencode task.
   */
  buildScheduleLaunch?: BuildScheduleLaunch
  /**
   * RFC-199 deterministic concurrency seam for exact workflow consumers.
   * Production leaves this undefined. Tests use it to commit a concurrent
   * workflow writer after the exact-revision guard and prove validation/YAML
   * serialization still consume the one captured immutable revision.
   */
  workflowExactOperationHook?: (input: {
    operation: 'validate' | 'export'
    revision: WorkflowRevision
  }) => void | Promise<void>
  /**
   * Test-only route dependency injection. Production callers must omit this;
   * the default path always invokes the registered runtime naturally.
   */
  runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticTestDependencies>
  /** RFC-234 test seam: stub the intent turn's system-agent run. */
  intentTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  /** RFC-238 test seams; production uses the real runtime runner and app home. */
  mcpRuntimeTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    now?: () => number
    appHome?: string
    capacity?: number
  }
  /** RFC-349 bootstrap-selected MCP runtime-test service. */
  mcpRuntimeTests?: McpDiagnosticsRuntime
}

/**
 * Route tables consume one already-composed task-execution runtime. Keeping
 * these fields required at the REST/MCP mount boundary makes every alternate
 * entry point (including direct dispatcher tests) choose an explicit bootstrap
 * composition instead of discovering a missing driver only on first request.
 */
type SqliteAppDeps = AppDeps & { readonly db: DbClient }

type RuntimeComposedAppDeps = SqliteAppDeps & {
  readonly taskExecutionModules: DaemonTaskExecutionModules<'sqlite'>
  readonly scheduledTaskModules: DaemonScheduledTaskModules
  readonly integrationModules: DaemonIntegrationModules
  readonly fusionModules: DaemonFusionModules
  readonly observationModules: DaemonObservationModules
  readonly resourceCatalogModules: DaemonResourceCatalogModules
  readonly repositoryCredentials: DaemonRepositoryCredentials
  readonly developmentPurposeRoot: SelectedDevelopmentPurposeRoot
  readonly authRuntime: AuthRuntime
  readonly tokenCallAudit: TokenCallAuditParticipant
  readonly healthDatabase: HealthDatabaseReadModel
  readonly systemOperations: SystemOperationsModule
  readonly maintenanceDisk: MaintenanceDiskOperations
  readonly webhookIngressPersistence: WebhookIngressPersistence
  readonly runtimeRegistry: RuntimeRegistryOperations
  readonly configConcurrencyHotApply: ConfigConcurrencyHotApplyCommand
  readonly identityAccess: IntegrationTriggerIdentityAccess
  readonly schedulerDriver: SchedulerDriverPort
  readonly taskExecutionReadModels: TaskExecutionReadModels
  readonly collaborationContext: CollaborationRouteContext
  readonly executionContracts: ReturnType<typeof composeExecutionContract>
  readonly codeHistoryQueries: CodeHistoryRouteQueries
  readonly developmentAdmissionLookup: DevelopmentAdmissionLookup
  readonly memoryDistillCommands: MemoryDistillCommands
  readonly memoryDistillQueries: MemoryDistillQueries
  readonly memoryOperations: MemoryOperations
}

export type IntegrationTriggerIdentityAccess = IdentityAccessRuntime & {
  readonly integrationTriggerResources: IntegrationTriggerResourceBinding
  readonly taskExecutionResources: TaskExecutionResourceBinding
}

function withIntegrationTriggerResources(
  identityAccess: IdentityAccessRuntime,
  integrationTriggerResources: IntegrationTriggerResourceBinding,
  taskExecutionResources: TaskExecutionResourceBinding,
): IntegrationTriggerIdentityAccess {
  return Object.freeze({ ...identityAccess, integrationTriggerResources, taskExecutionResources })
}

type RepositoryBootstrap = DaemonRepositoryCredentials

type SqliteComposedAppDeps = RuntimeComposedAppDeps &
  RepositoryBootstrap & {
    readonly workspacePresence: WorkspacePresenceQueries
    readonly developmentAutomation: DevelopmentAutomationModule
    readonly developmentAdapterAclIdentity: ReturnType<
      typeof composeDevelopmentAdapterConfigOperationsFor
    >['resourceAclIdentity']
    readonly developmentConfigOperations: DevelopmentConfigOperations
    readonly developmentMissionOperations: DevelopmentMissionOperations
  }

export type AppRouteMount = (app: Hono) => void

/**
 * Public transports are mounted before authentication.  Each binding is
 * composed by the selected provider and closes over provider-owned ports; the
 * common HTTP assembly never receives either database client.
 */
export interface AppPublicRouteMounts {
  readonly health: AppRouteMount
  readonly wellKnown: AppRouteMount
  readonly webhookIngress: AppRouteMount
  /** RFC-370 v3 V8 — hosted only: CrewStation's event delivery route. */
  readonly crewStationEvents?: AppRouteMount
}

/**
 * The route topology remains owned by this file.  Provider composition only
 * supplies closed mount bindings; `mountApiRoutes` invokes them below in one
 * fixed order for SQLite and PostgreSQL alike.
 */
export interface AppApiRouteMounts {
  readonly observability: AppRouteMount
  readonly config: AppRouteMount
  readonly maintenance: AppRouteMount
  readonly daemon: AppRouteMount
  readonly plantuml: AppRouteMount
  readonly runtime: AppRouteMount
  readonly runtimes: AppRouteMount
  readonly overview: AppRouteMount
  readonly agents: AppRouteMount
  readonly mcps: AppRouteMount
  readonly plugins: AppRouteMount
  readonly skills: AppRouteMount
  readonly skillProvenance: AppRouteMount
  readonly repos: AppRouteMount
  readonly cachedRepos: AppRouteMount
  readonly repoGroups: AppRouteMount
  readonly workflows: AppRouteMount
  readonly workgroups: AppRouteMount
  readonly resourcePackages: AppRouteMount
  readonly workgroupTasks: AppRouteMount
  readonly tasks: AppRouteMount
  readonly taskCatalog: AppRouteMount
  readonly taskArchive: AppRouteMount
  readonly maintenanceDisk: AppRouteMount
  readonly scheduledTasks: AppRouteMount
  readonly webhookEndpoints: AppRouteMount
  readonly codeHosts: AppRouteMount
  readonly repositoryTransportCredentials: AppRouteMount
  readonly code: AppRouteMount
  readonly capabilityTemplates: AppRouteMount
  readonly eventCenter: AppRouteMount
  readonly executionContracts: AppRouteMount
  readonly digitalEmployees: AppRouteMount
  readonly developmentConfig: AppRouteMount
  readonly developmentMissions: AppRouteMount
  readonly missionInputUploads: AppRouteMount
  readonly webhookTriggers: AppRouteMount
  readonly webhookDeliveries: AppRouteMount
  readonly backup: AppRouteMount
  readonly restore: AppRouteMount
  readonly databaseMigration?: AppRouteMount
  readonly worktreeFiles: AppRouteMount
  readonly portArtifacts: AppRouteMount
  readonly reviews: AppRouteMount
  readonly clarify: AppRouteMount
  readonly taskQuestions: AppRouteMount
  readonly taskClarifyDirective: AppRouteMount
  readonly fusion: AppRouteMount
  readonly intentSessions: AppRouteMount
  readonly memories: AppRouteMount
  readonly memoryDistillJobs: AppRouteMount
  readonly taskFeedback: AppRouteMount
  readonly auth: AppRouteMount
  readonly oidcAuth: AppRouteMount
  readonly oidc: AppRouteMount
  readonly users: AppRouteMount
  readonly docs: AppRouteMount
}

export type AppHttpProviderCore = Pick<
  DaemonProviderCore,
  'provider' | 'authRuntime' | 'tokenCallAudit' | 'identityAccess' | 'sourceWriteWindow'
>

/**
 * A production application keeps the complete selected-provider core.  HTTP
 * consumes only the authentication subset, while bootstrap reuses the same
 * value for WebSocket, health, repository and system-operation participants.
 */
/**
 * RFC-359 AC-10 —— 用**按 provider 索引的表**代替条件类型。
 *
 * 原来是 `TProvider extends 'postgresql' ? Pg… : …`：第三个 provider 进来会静默落进
 * false 分支、拿到 SQLite 那个模块类型，编译器一声不吭——正是本 RFC 要消灭的形状，
 * 只不过发生在类型层。
 *
 * 换成索引访问之后，`extends Record<DatabaseProvider, …>` 这条约束就是 forcing function：
 * 往 `DatabaseProvider` 里加一个成员，这个接口**立刻编译不过**，必须先回答「新 provider 的
 * system-operations 模块是哪一个」。
 */
/**
 * Provider-neutral application assembly consumed by production daemon
 * sessions.  This contract intentionally contains no SQLite/PG handle and no
 * optional provider fallback.  A full `DaemonProviderCore` is structurally
 * sufficient for the closed fields below. Production compositions retain the
 * complete core as a subtype, so bootstrap also reuses its `realtime`
 * participant without rebuilding a WebSocket provider.
 */
export interface ComposedAppDeps<TCore extends AppHttpProviderCore = AppHttpProviderCore> {
  readonly token: string
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
  readonly core: TCore
  readonly publicRoutes: AppPublicRouteMounts
  readonly apiRoutes: AppApiRouteMounts
  readonly executionAuthority?: ExecutionAuthorityPort
}

/** The completed HTTP employee instance also serves this bootstrap WorkStart port. */
export interface SqliteAppComposition<
  TCore extends AppHttpProviderCore = AppHttpProviderCore,
> extends ComposedAppDeps<TCore> {
  readonly taskExecutionModules: DaemonTaskExecutionModules<'sqlite'>
  readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  /**
   * RFC-359 —— 装配结果本来就在返回值里（`...runtimeDeps` 带出来的），只是类型上没声明。
   * 声明出来，测试夹具才能把「应用自己建的那一份」交给用例，而不是逼用例在外面再
   * `createTaskExecutionReadModels(db)` 建一份、再从 `AppDeps` 塞回去——那个形状把用例
   * 钉死在 SQLite 上（`PostgresqlApplicationInput` 没有、也不该有这个只服务测试的字段）。
   */
  readonly taskExecutionReadModels: TaskExecutionReadModels
  /** 同上：装配好的协作命令上下文，让夹具把它交给用例而不是逼用例重建。 */
  readonly collaborationContext: CollaborationRouteContext
  /**
   * RFC-359 —— 本进程**正在执行**的资源包 apply 的 journal id 快照。维护 Worker 拿它来
   * 决定哪些 journal 行不能回收：两台 apply 引擎合一前，SQLite 这一侧读的是 legacy
   * `services/bundle/apply` 的模块级集合；现在与 PostgreSQL 一样，读的是 apply 引擎自己的。
   */
  readonly resourcePackageApplyActivity: ResourcePackageApplyActivityQuery
  /**
   * RFC-359 —— 同上，Intent apply 那一侧。合一前 SQLite 读的是引擎的**模块级**集合
   * （`activeIntentApplyJournalIds()`），PostgreSQL 读的是注入进来的那台引擎；两台引擎
   * 合一后只剩后者——在飞集合是进程内的围栏，从 journal 行反推不出来。
   */
  readonly intentApplyActivity: IntentApplyActivitySource
}

export type ProviderComposedAppDeps<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> = ComposedAppDeps<SelectedDaemonProviderCore<TProvider>>

export interface ProviderPublicRouteComposition {
  readonly health: Readonly<{
    readonly deps: Parameters<typeof mountHealthRoutes>[1]
    readonly identityAccess: Parameters<typeof mountHealthRoutes>[2]
    readonly database: Parameters<typeof mountHealthRoutes>[3]
  }>
  readonly documentation: Parameters<typeof mountWellKnownRoutes>[1]
  readonly webhookIngress: ReturnType<typeof composeWebhookIngressTransport>
}

export interface ProviderPlatformRouteComposition {
  readonly observability: RunObservation
  readonly config: Parameters<typeof mountConfigRoutes>[1]
  readonly maintenance: Parameters<typeof mountMaintenanceRoutes>[1]
  readonly daemon: Parameters<typeof mountDaemonRoutes>[1]
  readonly plantuml: Parameters<typeof mountPlantumlRoutes>[1]
  readonly runtime: RuntimeModelQueries
  readonly runtimes: {
    readonly protocols: readonly RuntimeKind[]
    readonly profiles: RuntimeProfileCommands
    readonly queries: RuntimeProfileQueries
    readonly diagnostics: RuntimeDiagnosticCommands
  }
  readonly overview: Readonly<{
    readonly authorization: Parameters<typeof mountOverviewRoutes>[1]
    readonly query: Parameters<typeof mountOverviewRoutes>[2]
  }>
}

export interface ProviderResourceCatalogRouteComposition {
  readonly agents: Parameters<typeof mountAgentRoutes>[1]
  readonly mcps: Parameters<typeof mountMcpRoutes>[1]
  readonly plugins: Parameters<typeof mountPluginRoutes>[1]
  readonly skills: Parameters<typeof mountSkillRoutes>[1]
  readonly repositories: Readonly<{
    readonly store: Parameters<typeof mountRepoRoutes>[1]
    readonly cached: Parameters<typeof mountCachedRepoRoutes>[1]
    readonly groups: Parameters<typeof mountRepoGroupRoutes>[1]
    /** RFC-370 §10 V17: the selected repository mirrors. */
    readonly mirrors: RepositoryMirrors
  }>
  readonly workflows: Readonly<{
    readonly runtime: Parameters<typeof mountWorkflowRoutes>[1]
    readonly module: Parameters<typeof mountWorkflowRoutes>[2]
  }>
  readonly workgroups: Parameters<typeof mountWorkgroupRoutes>[1]
  readonly resourcePackages: Parameters<typeof registerResourcePackageRoutes>[1] | null
  readonly workgroupTasks: Parameters<typeof mountWorkgroupTaskRoutes>[1]
}

export interface ProviderTaskExecutionRouteComposition {
  readonly tasks: Parameters<typeof mountTaskRoutes>[1]
  readonly catalog: Parameters<typeof mountTaskCatalogRoutes>[1]
  readonly archive: Parameters<typeof mountTaskArchiveRoutes>[1]
  readonly portArtifacts: Parameters<typeof mountPortArtifactRoutes>[1]
  readonly clarifyDirective: Parameters<typeof mountTaskClarifyDirectiveRoutes>[1]
  readonly feedback: Parameters<typeof mountTaskFeedbackRoutes>[1]
}

export interface ProviderIntegrationRouteComposition {
  readonly scheduledTasks: Parameters<typeof mountScheduledTaskRoutes>[1]
  readonly webhookEndpoints: Parameters<typeof mountWebhookEndpointRoutes>[1] | null
  readonly eventCenter: Parameters<typeof mountEventCenterRoutes>[1]
  readonly webhookTriggers: Readonly<{
    readonly deps: Parameters<typeof mountWebhookTriggerRoutes>[1]
    readonly identityAccess: Parameters<typeof mountWebhookTriggerRoutes>[2]
  }>
  readonly webhookDeliveries: Parameters<typeof mountWebhookDeliveryRoutes>[1]
}

export interface ProviderSourceControlRouteComposition {
  readonly codeHosts: Readonly<{
    readonly deps: Parameters<typeof mountCodeHostRoutes>[1]
    readonly service: Parameters<typeof mountCodeHostRoutes>[2]
  }>
  readonly repositoryTransportCredentials: Readonly<{
    readonly runtime: Parameters<typeof mountAccountRepositoryTransportCredentialRoutes>[1]
    readonly route: Parameters<typeof mountAccountRepositoryTransportCredentialRoutes>[2]
  }> | null
  readonly worktreeFiles: Parameters<typeof mountWorktreeFilesRoutes>[1]
}

export interface ProviderCodeRouteComposition {
  readonly history: Parameters<typeof mountCodeRoutes>[1]
  readonly capabilityTemplates: Parameters<typeof mountCapabilityTemplateRoutes>[1]
}

export interface ProviderDigitalDevelopmentRouteComposition {
  readonly executionContracts: Parameters<typeof mountExecutionContractRoutes>[1]
  readonly digitalEmployees: Readonly<{
    readonly persistence: Parameters<typeof mountDigitalEmployeeRoutes>[1]
    readonly module: Parameters<typeof mountDigitalEmployeeRoutes>[2]
    readonly activityOperations: Parameters<typeof mountDigitalEmployeeRoutes>[3]
    readonly contexts: Parameters<typeof mountDigitalEmployeeRoutes>[4]
  }>
  readonly developmentConfig: Readonly<{
    readonly aclRoutes: Parameters<typeof mountDevelopmentConfigRoutes>[1]
    readonly operations: Parameters<typeof mountDevelopmentConfigRoutes>[2]
    readonly contexts: Parameters<typeof mountDevelopmentConfigRoutes>[3]
  }>
  readonly developmentMissions: Readonly<{
    readonly operations: Parameters<typeof mountDevelopmentMissionRoutes>[1]
    readonly contexts: Parameters<typeof mountDevelopmentMissionRoutes>[2]
  }>
  readonly missionInputUploads: Parameters<typeof mountMissionInputUploadRoutes>[1]
}

export interface ProviderCollaborationRouteComposition {
  readonly operations: Parameters<typeof mountClarifyRoutes>[1]
  readonly appHome: Parameters<typeof mountReviewRoutes>[2]
}

export interface ProviderMemoryRouteComposition {
  readonly fusion: Parameters<typeof mountFusionRoutes>[1]
  /** RFC-353 T9：技能来源追溯。归 knowledge-evolution，取数横跨 resource-catalog 与 memory。 */
  readonly skillProvenance: Parameters<typeof mountSkillProvenanceRoutes>[1]
  readonly memories: Readonly<{
    readonly catalog: Parameters<typeof mountMemoryRoutes>[1]
    readonly identityAccess: Parameters<typeof mountMemoryRoutes>[2]
  }>
  readonly distillJobs: Parameters<typeof mountMemoryDistillJobRoutes>[1]
}

export interface ProviderIdentityRouteComposition {
  readonly auth: Readonly<{
    readonly deps: Parameters<typeof mountAuthRoutes>[1]
    readonly identityAccess: Parameters<typeof mountAuthRoutes>[2]
    readonly bindings: Parameters<typeof mountAuthRoutes>[3]
  }>
  readonly oidcAuth: Readonly<{
    readonly deps: Parameters<typeof mountOidcAuthRoutes>[1]
    readonly bindings: Parameters<typeof mountOidcAuthRoutes>[2]
  }>
  readonly oidc: Parameters<typeof mountOidcRoutes>[1]
  readonly users: Readonly<{
    readonly auth: Parameters<typeof mountUserRoutes>[1]
    readonly identityAccess: Parameters<typeof mountUserRoutes>[2]
  }>
}

export interface ProviderSystemRouteComposition {
  readonly maintenanceDisk: Parameters<typeof mountMaintenanceDiskRoutes>[1]
  readonly backup: Readonly<{
    readonly operations: Parameters<typeof mountBackupRoutes>[1]
    readonly identityAccess: Parameters<typeof mountBackupRoutes>[2]
  }>
  readonly restore: Readonly<{
    readonly operations: Parameters<typeof mountRestoreRoutes>[1]
    readonly identityAccess: Parameters<typeof mountRestoreRoutes>[2]
  }>
  readonly databaseMigration: Readonly<{
    readonly operations: Parameters<typeof mountDatabaseMigrationRoutes>[1]
    readonly identityAccess: Parameters<typeof mountDatabaseMigrationRoutes>[2]
  }>
}

/**
 * Complete provider-selected application input.  Every member is an owner
 * aggregate or closed route port; no route closure and no database handle may
 * cross this boundary.  `server.ts` alone turns these values into the fixed
 * route topology.
 */
export interface ProviderAppCompositionInput<
  TProvider extends DaemonProviderCore['provider'] = DaemonProviderCore['provider'],
> {
  readonly token: string
  readonly configuration: ApplicationConfigurationQueries
  readonly authentication: HttpAuthenticationParticipant
  readonly core: SelectedDaemonProviderCore<TProvider>
  readonly public: ProviderPublicRouteComposition
  readonly platform: ProviderPlatformRouteComposition
  readonly resourceCatalog: ProviderResourceCatalogRouteComposition
  readonly taskExecution: ProviderTaskExecutionRouteComposition
  readonly integration: ProviderIntegrationRouteComposition
  readonly sourceControl: ProviderSourceControlRouteComposition
  readonly code: ProviderCodeRouteComposition
  readonly digitalDevelopment: ProviderDigitalDevelopmentRouteComposition
  readonly collaboration: ProviderCollaborationRouteComposition
  readonly memory: ProviderMemoryRouteComposition
  readonly intent: IntentSessionRouteDependencies
  readonly identity: ProviderIdentityRouteComposition
  readonly system: ProviderSystemRouteComposition
  /** RFC-370 v2 H7: bootstrap-selected execution authority; absent means standalone. */
  readonly executionAuthority?: ExecutionAuthorityPort
}

export type SqliteAppCompositionInput = ProviderAppCompositionInput<'sqlite'>
export type PostgresqlAppCompositionInput = ProviderAppCompositionInput<'postgresql'>

/** Freeze one server-owned route assembly after its provider aggregates bind. */
function freezeComposedAppDeps<TCore extends AppHttpProviderCore>(
  input: ComposedAppDeps<TCore>,
): ComposedAppDeps<TCore> {
  return Object.freeze({
    token: input.token,
    configuration: input.configuration,
    authentication: input.authentication,
    core: Object.freeze({ ...input.core }),
    publicRoutes: Object.freeze({ ...input.publicRoutes }),
    apiRoutes: Object.freeze({ ...input.apiRoutes }),
    executionAuthority: input.executionAuthority,
  })
}

/**
 * Bind one daemon's already-composed owner aggregates to the canonical HTTP
 * route topology. Provider clients stay captured inside the injected
 * aggregates, so this boundary cannot silently select another provider.
 */
export function composeProviderAppDeps<TProvider extends DaemonProviderCore['provider']>(
  input: ProviderAppCompositionInput<TProvider>,
): ProviderComposedAppDeps<TProvider> {
  const publicRoutes = Object.freeze({
    health: (app: Hono) =>
      mountHealthRoutes(
        app,
        input.public.health.deps,
        input.public.health.identityAccess,
        input.public.health.database,
      ),
    wellKnown: (app: Hono) => mountWellKnownRoutes(app, input.public.documentation),
    webhookIngress: (app: Hono) => mountWebhookIngressRoutes(app, input.public.webhookIngress),
    crewStationEvents: (app: Hono) => input.public.webhookIngress.crewStationEvents?.mount(app),
  } satisfies AppPublicRouteMounts)

  const apiRoutes = Object.freeze({
    config: (app: Hono) => mountConfigRoutes(app, input.platform.config),
    observability: (app: Hono) => input.platform.observability.mount(app),
    maintenance: (app: Hono) => mountMaintenanceRoutes(app, input.platform.maintenance),
    daemon: (app: Hono) => mountDaemonRoutes(app, input.platform.daemon),
    plantuml: (app: Hono) => mountPlantumlRoutes(app, input.platform.plantuml),
    runtime: (app: Hono) => mountRuntimeRoutes(app, input.platform.runtime),
    runtimes: (app: Hono) => mountRuntimesRoutes(app, input.platform.runtimes),
    overview: (app: Hono) =>
      mountOverviewRoutes(
        app,
        input.platform.overview.authorization,
        input.platform.overview.query,
      ),
    agents: (app: Hono) => mountAgentRoutes(app, input.resourceCatalog.agents),
    mcps: (app: Hono) => mountMcpRoutes(app, input.resourceCatalog.mcps),
    plugins: (app: Hono) => mountPluginRoutes(app, input.resourceCatalog.plugins),
    skills: (app: Hono) => mountSkillRoutes(app, input.resourceCatalog.skills),
    skillProvenance: (app: Hono) => mountSkillProvenanceRoutes(app, input.memory.skillProvenance),
    repos: (app: Hono) =>
      mountRepoRoutes(
        app,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    cachedRepos: (app: Hono) =>
      mountCachedRepoRoutes(
        app,
        input.resourceCatalog.repositories.cached,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    repoGroups: (app: Hono) =>
      mountRepoGroupRoutes(
        app,
        input.resourceCatalog.repositories.groups,
        input.resourceCatalog.repositories.store,
        input.resourceCatalog.repositories.mirrors,
      ),
    workflows: (app: Hono) =>
      mountWorkflowRoutes(
        app,
        input.resourceCatalog.workflows.runtime,
        input.resourceCatalog.workflows.module,
      ),
    workgroups: (app: Hono) => mountWorkgroupRoutes(app, input.resourceCatalog.workgroups),
    resourcePackages: (app: Hono) => {
      if (input.resourceCatalog.resourcePackages === null) return
      registerResourcePackageRoutes(app, input.resourceCatalog.resourcePackages)
    },
    workgroupTasks: (app: Hono) =>
      mountWorkgroupTaskRoutes(app, input.resourceCatalog.workgroupTasks),
    tasks: (app: Hono) => mountTaskRoutes(app, input.taskExecution.tasks),
    taskCatalog: (app: Hono) => mountTaskCatalogRoutes(app, input.taskExecution.catalog),
    taskArchive: (app: Hono) => mountTaskArchiveRoutes(app, input.taskExecution.archive),
    maintenanceDisk: (app: Hono) => mountMaintenanceDiskRoutes(app, input.system.maintenanceDisk),
    scheduledTasks: (app: Hono) => mountScheduledTaskRoutes(app, input.integration.scheduledTasks),
    webhookEndpoints: (app: Hono) => {
      if (input.integration.webhookEndpoints === null) return
      mountWebhookEndpointRoutes(app, input.integration.webhookEndpoints)
    },
    codeHosts: (app: Hono) =>
      mountCodeHostRoutes(
        app,
        input.sourceControl.codeHosts.deps,
        input.sourceControl.codeHosts.service,
      ),
    repositoryTransportCredentials: (app: Hono) => {
      const credentials = input.sourceControl.repositoryTransportCredentials
      if (credentials === null) return
      mountAccountRepositoryTransportCredentialRoutes(app, credentials.runtime, credentials.route)
    },
    code: (app: Hono) => mountCodeRoutes(app, input.code.history),
    capabilityTemplates: (app: Hono) =>
      mountCapabilityTemplateRoutes(app, input.code.capabilityTemplates),
    eventCenter: (app: Hono) => mountEventCenterRoutes(app, input.integration.eventCenter),
    executionContracts: (app: Hono) =>
      mountExecutionContractRoutes(app, input.digitalDevelopment.executionContracts),
    digitalEmployees: (app: Hono) =>
      mountDigitalEmployeeRoutes(
        app,
        input.digitalDevelopment.digitalEmployees.persistence,
        input.digitalDevelopment.digitalEmployees.module,
        input.digitalDevelopment.digitalEmployees.activityOperations,
        input.digitalDevelopment.digitalEmployees.contexts,
      ),
    developmentConfig: (app: Hono) =>
      mountDevelopmentConfigRoutes(
        app,
        input.digitalDevelopment.developmentConfig.aclRoutes,
        input.digitalDevelopment.developmentConfig.operations,
        input.digitalDevelopment.developmentConfig.contexts,
      ),
    developmentMissions: (app: Hono) =>
      mountDevelopmentMissionRoutes(
        app,
        input.digitalDevelopment.developmentMissions.operations,
        input.digitalDevelopment.developmentMissions.contexts,
      ),
    missionInputUploads: (app: Hono) =>
      mountMissionInputUploadRoutes(app, input.digitalDevelopment.missionInputUploads),
    webhookTriggers: (app: Hono) =>
      mountWebhookTriggerRoutes(
        app,
        input.integration.webhookTriggers.deps,
        input.integration.webhookTriggers.identityAccess,
      ),
    webhookDeliveries: (app: Hono) =>
      mountWebhookDeliveryRoutes(app, input.integration.webhookDeliveries),
    backup: (app: Hono) =>
      mountBackupRoutes(app, input.system.backup.operations, input.system.backup.identityAccess),
    restore: (app: Hono) =>
      mountRestoreRoutes(app, input.system.restore.operations, input.system.restore.identityAccess),
    databaseMigration: (app: Hono) =>
      mountDatabaseMigrationRoutes(
        app,
        input.system.databaseMigration.operations,
        input.system.databaseMigration.identityAccess,
      ),
    worktreeFiles: (app: Hono) => mountWorktreeFilesRoutes(app, input.sourceControl.worktreeFiles),
    portArtifacts: (app: Hono) => mountPortArtifactRoutes(app, input.taskExecution.portArtifacts),
    reviews: (app: Hono) =>
      mountReviewRoutes(app, input.collaboration.operations, input.collaboration.appHome),
    clarify: (app: Hono) => mountClarifyRoutes(app, input.collaboration.operations),
    taskQuestions: (app: Hono) => mountTaskQuestionRoutes(app, input.collaboration.operations),
    taskClarifyDirective: (app: Hono) =>
      mountTaskClarifyDirectiveRoutes(app, input.taskExecution.clarifyDirective),
    fusion: (app: Hono) => mountFusionRoutes(app, input.memory.fusion),
    intentSessions: (app: Hono) => mountIntentSessionRoutes(app, input.intent),
    memories: (app: Hono) =>
      mountMemoryRoutes(app, input.memory.memories.catalog, input.memory.memories.identityAccess),
    memoryDistillJobs: (app: Hono) => mountMemoryDistillJobRoutes(app, input.memory.distillJobs),
    taskFeedback: (app: Hono) => mountTaskFeedbackRoutes(app, input.taskExecution.feedback),
    auth: (app: Hono) =>
      mountAuthRoutes(
        app,
        input.identity.auth.deps,
        input.identity.auth.identityAccess,
        input.identity.auth.bindings,
      ),
    oidcAuth: (app: Hono) =>
      mountOidcAuthRoutes(app, input.identity.oidcAuth.deps, input.identity.oidcAuth.bindings),
    oidc: (app: Hono) => mountOidcRoutes(app, input.identity.oidc),
    users: (app: Hono) =>
      mountUserRoutes(app, input.identity.users.auth, input.identity.users.identityAccess),
    docs: (app: Hono) => mountDocsRoutes(app, input.public.documentation),
  } satisfies AppApiRouteMounts)

  return freezeComposedAppDeps({
    token: input.token,
    configuration: input.configuration,
    authentication: input.authentication,
    core: input.core,
    executionAuthority: input.executionAuthority,
    publicRoutes,
    apiRoutes,
  })
}

/** Named production entry points keep provider selection explicit at bootstrap. */
export function composePostgresqlAppDeps(
  input: PostgresqlAppCompositionInput,
): ProviderComposedAppDeps<'postgresql'> {
  return composeProviderAppDeps(input)
}

function composeLegacyConfigConcurrencyHotApply(
  daemonScope: object,
): ConfigConcurrencyHotApplyCommand {
  return Object.freeze({
    apply(input: Parameters<ConfigConcurrencyHotApplyCommand['apply']>[0]) {
      resizeAllNodePools(daemonScope, {
        agent: input.maxConcurrentNodes,
        script: input.maxConcurrentScriptNodes,
        'code-host': input.maxConcurrentCodeHostCalls,
      })
      resizeAllTaskFanoutSems(input.multiProcessSubprocessConcurrency)
      setChildTaskBudgetCapacity(input.maxActiveChildTasks)
    },
  })
}

function composeFallbackDevelopmentAutomation(
  deps: RuntimeComposedAppDeps &
    RepositoryBootstrap & { readonly workspacePresence: WorkspacePresenceQueries },
  appHome: string,
  // RFC-345：Agent 查询由 bootstrap 从模块的目录查询面提供，本文件不再经 services/agent 门面。
  agents: Parameters<typeof composeAgentActionExecution>[0]['agents'],
): DevelopmentAutomationModule {
  const hostActionEnvironment = {
    db: deps.db,
    launch: deps.taskExecutionModules.routeLaunch.workflow,
    resolveActor: async () => {
      const identity = await admitDaemonIdentity(deps.identityAccess)
      if (identity === null) throw new Error('digital-employee-host-identity-not-admitted')
      return actorOfDirectAuthority(identity)
    },
    resourceAuthorityFor: (actor: Actor) => ({
      actor,
      authority: deps.identityAccess.directAuthority.authorityForLegacyProjection(actor),
      resources: deps.identityAccess.taskExecutionResources,
    }),
    cancelTask: (taskId: string) => composeTaskCancellation(deps.db).cancel(taskId),
    readModels: deps.taskExecutionReadModels,
  }
  // RFC-359 W11：终态观察者要回调 `automation.drive`，而 automation 的两个 launcher 又要这个
  // 观察者。环打在**词法作用域**上，不再打在一个可空的盒子上：`automation` 是同一作用域里的
  // `const`，箭头只在运行期取值。这样「忘了回填」在类型层不可表达——删掉下面那行
  // `const automation = …`，tsc 立刻报「Cannot find name 'automation'」，而不是留下一个
  // 编译通过、跑起来每次都 reject 的组合根。
  const terminalObserver = createDevelopmentMissionExecutionTerminalObserver({
    db: deps.db,
    drive: (missionId) => automation.drive(missionId),
  })
  const automation = composeDevelopmentAutomation({
    verificationCommands:
      deps.verificationCommands === undefined
        ? createLocalVerificationCommandEffectsFactory()
        : deps.verificationCommands,
    actionWorkspaceEffects: deps.actionWorkspaceEffects,
    automationWorkspaceEffects: deps.automationWorkspaceEffects,
    repositoryBaselines: deps.repositoryBaselines,
    db: deps.db,
    appHome,
    evidenceArtifacts: deps.developmentPurposeRoot.evidenceArtifacts,
    evidenceRead: deps.evidenceRead,
    evidenceDocumentCommands: deps.developmentPurposeRoot.requirement.documentCommands,
    requirementStaging: deps.developmentPurposeRoot.requirement.staging,
    attemptContext: deps.attemptContext,
    admissionLookup: deps.developmentAdmissionLookup,
    requirementSource: composeSelectedRequirementSourceRunnerFor(
      deps.db,
      deps.developmentPurposeRoot.requirement,
    ),
    changeCandidate: bindChangeCandidateParticipant({
      candidateEffects: deps.repositoryCandidateEffects,
    }),
    candidateDelivery: bindCandidateDeliveryParticipant({
      candidateEffects: deps.repositoryCandidateEffects,
      publicationTransport: deps.repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: deps.conflictMergeWorkspaceEffects }),
    ...buildDevelopmentDeliveryDeps(
      deps.developmentDeliveryProvider,
      deps.developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentPipelineDeps(
      deps.developmentDeliveryProvider.pipeline,
      deps.developmentPurposeRoot.pipeline.staging,
    ),
    ...buildDevelopmentMrFactsDeps(deps.developmentDeliveryProvider),
    agentLauncher: composeAgentActionExecution({
      ...hostActionEnvironment,
      agents,
      onTerminal: terminalObserver.agent,
    }),
    scriptLauncher: composeScriptActionExecution({
      ...hostActionEnvironment,
      agents,
      onTerminal: terminalObserver.script,
    }),
    approvalGateway: deps.integrationModules.developmentApprovalGateway,
  })
  return automation
}

/** Owned finite resource initialization and runtime-test composition for one application. */
export interface UnstartedApplicationScope {
  readonly trackReady: <T>(ready: Promise<T>) => Promise<T>
  readonly createMcpRuntimeTests: (deps: McpDiagnosticsCompositionInput) => McpDiagnosticsRuntime
}

export function composeSqliteAppDeps(
  deps: AppDeps & { readonly providerCore: SelectedDaemonProviderCore<'sqlite'> },
): SqliteAppComposition<SelectedDaemonProviderCore<'sqlite'>>
export function composeSqliteAppDeps(deps: AppDeps): SqliteAppComposition
export function composeSqliteAppDeps(deps: AppDeps): SqliteAppComposition {
  return composeSqliteApplicationDeps(deps)
}

export function composeSqliteApplicationDeps(
  deps: AppDeps,
  unstarted?: UnstartedApplicationScope,
): SqliteAppComposition {
  const appHome = deps.appHome ?? Paths.root
  const workspaceUploads = selectWorkspaceUploadContentFactory(deps.workspaceUploads)
  const isolationWorkspaces = selectIsolationWorkspaceFactory(deps.isolationWorkspaces)
  const repositoryGitWorkspaces = selectRepositoryGitWorkspaceFactory(deps.repositoryGitWorkspaces)
  const workspaceReads = selectRepositoryWorkspaceReadQueries(deps.workspaceReads)
  const developmentPurposeRoot =
    deps.developmentPurposeRoot ??
    composeDevelopmentPurposeRoot({
      appHome,
      selection: deps.developmentPurposes,
      evidenceArtifacts: deps.evidenceArtifacts,
      evidenceDocumentCommands: deps.evidenceDocumentCommands,
    })
  const selectedTaskRuns = selectTaskRunRootSelection(deps.taskRunSelection)
  const workspaceExcludeProfilesFor = composeTaskWorkspaceExcludeProfilesFor(
    deps.workspaceExcludeProfiles,
  )
  const nodeRunPrompts =
    selectedTaskRuns === undefined
      ? deps.nodeRunPrompts === undefined
        ? composeNodeRunPromptOperations(deps.nodeRunPromptContentEffects, join(appHome, 'runs'))
        : selectNodeRunPromptOperations(deps.nodeRunPrompts)
      : selectedTaskRuns.nodeRunPrompts
  const portArtifacts =
    selectedTaskRuns === undefined
      ? deps.portArtifacts === undefined
        ? composePortArtifactOperations(deps.portArtifactContentEffects, appHome)
        : selectPortArtifactOperations(deps.portArtifacts, appHome)
      : selectedTaskRuns.portArtifacts
  const taskRunRoot =
    selectedTaskRuns === undefined
      ? composeLocalTaskRunRootSelection({ nodeRunPrompts, portArtifacts })
      : selectedTaskRuns
  const applicationConfiguration =
    deps.applicationConfiguration ??
    composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: deps.configPath,
      ...(deps.configuration === undefined ? {} : { queries: deps.configuration }),
    })
  const configuration = applicationConfiguration.queries
  const taskLaunchConfiguration = composeTaskLaunchConfiguration(
    deps.applicationConfiguration !== undefined ||
      applicationConfiguration.synchronousQueries === undefined
      ? { kind: 'selected', queries: configuration }
      : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
  )
  const providerCore: DaemonProviderCore =
    deps.providerCore ??
    composeDaemonProviderCore({
      db: deps.db,
      appHome,
      secretBox: deps.secretBox,
      daemonToken: deps.token,
      adapters: DAEMON_PROVIDER_CORE_ADAPTERS.sqlite({
        db: deps.db,
        appHome,
        secretBox: deps.secretBox,
      }),
      realtimePolicy: composeDaemonRealtimePolicy({
        resourceVisibility: {
          canViewResource: (actor, type, row) =>
            resourceCatalogModules.resourceCatalog.authorization.canViewResource(actor, type, row),
        },
        memoryVisibility: {
          canViewMemory: (authority, actor, scope) =>
            memoryCatalog.queries.canView({ authority, actor }, scope),
        },
        repoImportOwnerUserId: batchOwnerUserId,
        redactTaskEventPayload: redactEventPayload,
      }),
      onCredentialRevoked: triggerRevalidation,
      identityEvents: { authorityRevisionChanged() {} },
      presenceProjection: { publish() {} },
    })
  const scheduledTaskModules: DaemonScheduledTaskModules =
    deps.scheduledTaskModules ??
    composeDaemonScheduledTaskModules({
      db: deps.db,
      assertAgentIntegrity: (agentIds) =>
        agentResourceIntegrity.launch.assertUsable({ rootAgentIds: agentIds }),
    })
  const baseIdentityAccess = deps.identityAccess ?? providerCore.identityAccess
  const authRuntime = deps.authRuntime ?? providerCore.authRuntime
  const tokenCallAudit = deps.tokenCallAudit ?? providerCore.tokenCallAudit
  const healthDatabase = deps.healthDatabase ?? providerCore.healthDatabase
  const runtimeRegistry = deps.runtimeRegistry ?? providerCore.runtimeRegistry
  const standalone = standaloneModuleAdapters()
  const observationModules: DaemonObservationModules =
    deps.observationModules ??
    composeDaemonObservationModules({
      db: deps.db,
      appHome,
      configuration,
      notificationKey: applicationConfiguration.notificationKey,
      identityAccess: baseIdentityAccess,
      runtimeRegistry,
      mcpCatalog: () => mcpCatalog,
      adapters: {
        ...standalone,
        mcpDiagnostics: unstarted?.createMcpRuntimeTests ?? standalone.mcpDiagnostics,
        runtimeManagement: deps.runtimeManagement ?? standalone.runtimeManagement,
        workspacePresence: () => deps.workspacePresence ?? standalone.workspacePresence(),
      },
      mcpRuntimeTests: deps.mcpRuntimeTests,
      mcpRuntimeTestDependencies: deps.mcpRuntimeTestDependencies,
      runtimeDiagnosticTestDependencies: deps.runtimeDiagnosticTestDependencies,
    })
  const { workspacePresence, mcpRuntimeTests: userRuntimeTests } = observationModules
  const resourceCatalogModules: DaemonResourceCatalogModules =
    deps.resourceCatalogModules ??
    composeDaemonResourceCatalogModules({
      db: deps.db,
      skillContentRoot: Paths.root,
      skillContent: deps.skillContent,
      pluginInstaller: deps.pluginInstaller,
      runtimeProfiles: { get: (name) => runtimeRegistry.getRuntime(name) },
      mcpRuntime: {
        prepareDelete: (id) => userRuntimeTests.prepareMcpDelete(id),
        reconcileDurableIntents: () => userRuntimeTests.reconcileDurableIntents(),
      },
    })
  const {
    resourceCatalog: providerResourceCatalog,
    agentResourceIntegrity,
    agentCatalog,
    mcpProbeStore,
    mcpCatalog,
    pluginCatalog,
    skillCatalog,
    workflowCatalog,
    workgroupCatalog,
    developmentAdapterConfigOperations,
    developmentConfigOperations,
  } = resourceCatalogModules
  const repositoryBootstrap =
    deps.repositoryCredentials ??
    composeDaemonRepositoryCredentials({
      db: deps.db,
      appHome,
      secretBox: deps.secretBox,
      developmentPurposeRoot,
      repositoryWorkspaceStore:
        deps.repositoryWorkspaceStore ?? providerCore.repositoryWorkspaceStore,
      repositoryWorkspaceOperations: providerCore.repositoryWorkspaceOperations,
      repositoryTransportCredentialRepository:
        deps.repositoryTransportCredentialRepository ??
        providerCore.repositoryTransportCredentialRepository,
      repositoryTransport: deps.repositoryTransport,
      repositoryPublicationTransport: deps.repositoryPublicationTransport,
      developmentWorkspaceRepositoryPreparation: deps.developmentWorkspaceRepositoryPreparation,
      codeHostFetch: deps.codeHostFetch,
    })
  const memoryModules: DaemonMemoryModules =
    deps.memoryModules ??
    composeDaemonMemoryModules({
      db: deps.db,
      nodeRunPrompts,
      systemAgentBinding: observationModules.memorySystemAgentBinding,
      contexts: baseIdentityAccess.contexts,
      operations: deps.memoryOperations,
      reviewedArtifacts: {
        read: async (finalPath) =>
          await readCommittedReviewArtifactBody(collaborationContext, finalPath),
      },
    })
  const { memoryOperations, memoryCatalog } = memoryModules
  const configConcurrencyHotApply =
    deps.configConcurrencyHotApply ?? composeLegacyConfigConcurrencyHotApply(deps.db)
  const taskExecutionModules: DaemonTaskExecutionModules<'sqlite'> =
    deps.taskExecutionModules ??
    composeDaemonTaskExecutionModules({
      db: deps.db,
      appHome,
      configPath: deps.configPath,
      secretBox: deps.secretBox,
      taskLaunchConfiguration,
      adapters: DAEMON_TASK_EXECUTION_ADAPTERS.sqlite({ db: deps.db }),
      core: {
        ...providerCore,
        identityAccess: baseIdentityAccess,
        runtimeRegistry,
        repositoryWorkspaceStore: repositoryBootstrap.repositoryWorkspaceStore,
      },
      observation: observationModules,
      resources: { agentResourceIntegrity, owners: composeOwnerIdentityQueries(deps.db) },
      repository: repositoryBootstrap,
      memory: memoryModules,
      selection: {
        taskRunBinding: taskRunRoot.drive,
        workspaceExcludeProfilesFor,
        nodeRunPrompts,
        portArtifacts,
        isolationWorkspaces,
        repositoryGitWorkspaces,
        workspaceReads,
        archive: deps.taskArchive,
        effects: deps.taskDeletionEffects,
        archivedEvents: deps.archivedNodeEvents,
        reviewArtifacts: deps.reviewArtifacts,
        reviewRollbackSnapshots: deps.reviewRollbackSnapshots,
        workspaceUploads,
        preparationEffects: deps.repositoryPreparationEffects,
        scratchEffects: deps.scratchWorkspaceEffects,
        fusionWorkspaces: createFileFusionWorkspaceEffects({ appHome }),
      },
      testSeams: {
        schedulerDriver: deps.schedulerDriver,
        collaboration: deps.collaborationContext,
      },
      finalizeWorkspace: async (taskId) => {
        await finishClaimedWebhookWorkspacePrune(deps.db, taskId)
      },
    })
  const taskExecutionPersistence = taskExecutionModules.persistence
  const taskExecutionReadModels = deps.taskExecutionReadModels ?? taskExecutionModules.readModels
  const schedulerDriver = taskExecutionModules.runtime.schedulerDriver
  const collaborationContext = taskExecutionModules.collaboration
  const identityAccess = withIntegrationTriggerResources(
    baseIdentityAccess,
    scheduledTaskModules.scheduledTaskRuntime.integrationTriggerResources,
    taskExecutionModules.resources,
  )
  const systemOperations = deps.systemOperations ?? providerCore.systemOperations
  const maintenanceDisk = providerCore.maintenanceDisk
  const fusionModules: DaemonFusionModules =
    deps.fusionModules ??
    composeDaemonFusionModules({
      db: deps.db,
      appHome,
      memories: memoryCatalog,
      skillContent: deps.skillContent,
      taskLaunchConfiguration,
      tasks: taskExecutionModules.fusion,
    })
  const integrationModules: DaemonIntegrationModules =
    deps.integrationModules ??
    composeDaemonIntegrationModules({
      db: deps.db,
      secretBox: deps.secretBox,
      configuration,
      scheduledTaskRuntime: scheduledTaskModules.scheduledTaskRuntime,
      identityAccess,
      bindEventAutomationContexts: createEventAutomationDelegatedContextBinding,
      runtimeRegistry: taskExecutionModules.executionModule.runtimeRegistry,
      workspaceMaintenance: composeWorkspaceMaintenanceCommand({
        db: deps.db,
        appHome,
        terminalMaintenance: taskExecutionPersistence.terminalMaintenance,
        isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
        invalidateWorkspacePath: invalidateCallGraphIndex,
      }),
      taskExecutions: taskExecutionModules.trigger.taskExecutions,
      digitalEmployeeWorkStart: {
        launch: (request) => apiComposition.digitalEmployeeWorkStart.launch(request),
      },
      developmentDeliveryProvider: repositoryBootstrap.developmentDeliveryProvider,
      developmentPurposeRoot,
      adapters: {
        beforeEventObservationWrite: deps.beforeEventObservationWrite,
        customObserverPrograms: deps.customObserverPrograms,
        webhookDispatcher: deps.webhookDispatcher,
        webhookTerminalControl: deps.webhookTerminalControl,
        eventCenter: deps.digitalEmployeeEventCenter,
        webhookIngressPersistence: deps.webhookIngressPersistence,
      },
    })
  if (deps.integrationModules === undefined && deps.digitalEmployeeEventCenter === undefined) {
    void unstarted?.trackReady(integrationModules.eventCenter.initialize())
  }
  const runtimeDeps: RuntimeComposedAppDeps = {
    ...deps,
    taskExecutionModules,
    scheduledTaskModules,
    integrationModules,
    fusionModules,
    digitalEmployeeEventCenter: integrationModules.eventCenter,
    // Direct HTTP tests may intentionally omit dispatch/terminal ports. Session bundles
    // are always fully wired; retain the original optional seams for the unstarted fallback.
    webhookDispatcher: deps.integrationModules?.webhookDispatcher ?? deps.webhookDispatcher,
    webhookTerminalControl:
      deps.integrationModules?.webhookTerminalControl ?? deps.webhookTerminalControl,
    ...selectDevelopmentWorkspaceEffectBinding({
      actionWorkspaceEffects: deps.actionWorkspaceEffects,
      automationWorkspaceEffects: deps.automationWorkspaceEffects,
      conflictWorkspaceSelected: deps.conflictMergeWorkspaceEffects !== undefined,
    }),
    developmentPurposeRoot,
    observationModules,
    resourceCatalogModules,
    repositoryCredentials: repositoryBootstrap,
    appHome,
    authRuntime,
    tokenCallAudit,
    healthDatabase,
    systemOperations,
    maintenanceDisk,
    webhookIngressPersistence: integrationModules.webhookIngressPersistence,
    runtimeRegistry,
    configConcurrencyHotApply,
    identityAccess,
    digitalEmployeeCaseDetailProjection:
      deps.digitalEmployeeCaseDetailProjection ??
      composeDevelopmentEmployeeCaseDetailProjection(
        createDevelopmentEmployeeCaseWorkspaceDetailReader(deps.db),
      ),
    schedulerDriver,
    taskExecutionReadModels,
    executionContracts:
      deps.executionContracts ??
      composeExecutionContract({
        registrations: developmentExecutionContractRegistrations,
        resources: createExecutionContractResourceAdapter(
          deps.db,
          developmentImplicitAgentContractDeclarations,
        ),
        // RFC-370 §10 V19: a selected program store answers fixture reads
        // too (the same store the authoring wrote), on both roots.
        programFixtures: createExecutionContractProgramFixtureAdapter({
          appHome: appHome,
          ...(deps.employeePrograms === undefined
            ? {}
            : { programs: createArtifactProgramToolSource(deps.employeePrograms) }),
        }),
      }),
    codeHistoryQueries: deps.codeHistoryQueries ?? composeCodeHistoryQueries(deps.db),
    developmentAdmissionLookup:
      deps.developmentAdmissionLookup ?? composeDevelopmentAdmissionLookup(deps.db),
    memoryDistillCommands: memoryOperations.distillCommands,
    memoryDistillQueries: deps.memoryDistillQueries ?? memoryOperations.distillQueries,
    memoryOperations,
    collaborationContext,
  }
  const developmentAutomation =
    runtimeDeps.developmentAutomation ??
    composeFallbackDevelopmentAutomation(
      { ...runtimeDeps, ...repositoryBootstrap, workspacePresence },
      appHome,
      {
        // RFC-359 W11：动作执行只在运行期查代理，目录是同一作用域里的 `const agentCatalog`
        // （下面几十行）。词法闭包代替了「先留空、装配完再回填」的槽。
        get: async (id) => {
          const identity = await admitDaemonIdentity(identityAccess)
          if (identity === null) throw new Error('agent-action-authority-not-admitted')
          return agentCatalog.queries.get(identity.actor, { id })
        },
      },
    )
  const developmentMissionOperations = composeDevelopmentMissionOperations({
    repositoryBaselines: deps.repositoryBaselines,
    db: runtimeDeps.db,
    deliveryProvider: repositoryBootstrap.developmentDeliveryProvider,
    admissionLookup: runtimeDeps.developmentAdmissionLookup,
    automation: developmentAutomation,
    legacyAdmissionsEnabled: createLegacyMissionAdmissionsEnabledQuery(
      composeDigitalEmployeeWriterCutoverFor(runtimeDeps.db),
    ),
  })
  const effectiveDeps: SqliteComposedAppDeps = {
    ...runtimeDeps,
    workspaceUploads,
    isolationWorkspaces,
    repositoryGitWorkspaces,
    workspaceReads,
    nodeRunPrompts,
    portArtifacts,
    workspacePresence,
    ...repositoryBootstrap,
    // RFC-317 T54：装配落在 bootstrap。HTTP 与 MCP operation adapter
    // 拿到的是**同一个**实例；MCP 不再另建 route table。
    developmentAutomation,
    developmentAdapterAclIdentity: developmentAdapterConfigOperations.resourceAclIdentity,
    developmentConfigOperations,
    developmentMissionOperations,
  }

  // RFC-359 —— 资源包 apply **一台引擎两个 provider**：此处此前装的是 SQLite 专属的
  // `commitResourcePackage`（同步事务里的 legacy 参与者），PostgreSQL 那台装的是
  // journal + prestage/compensate 的原子 apply。两份做同一件事，判据却只跑前者。
  // 现在两边都装后者；`authorityResolver` 把路由那一层的 authority 认回请求者本人。
  const packageActorsByAuthority = new WeakMap<object, Actor>()
  const resourcePackageBinding: ResourcePackageRouteBinding | null = (() => {
    const box = effectiveDeps.secretBox
    const provider = composePostgresqlResourcePackageProvider({
      db: effectiveDeps.db,
      appHome,
      authorityResolver: {
        resolve(authority) {
          const actor = packageActorsByAuthority.get(authority)
          if (actor === undefined) throw new Error('foreign-resource-package-authority')
          return actor
        },
      },
      mcpLifecycle: resourceCatalogModules.mcpTransactionLifecycle,
      capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
        db: effectiveDeps.db,
      }),
      skillArtifacts: effectiveDeps.resourcePackageSkillArtifacts,
      skillPackageContent: effectiveDeps.resourcePackageSkillContent,
      ...(effectiveDeps.resourcePackagePluginArtifacts === undefined
        ? { pluginInstaller: createResourcePackagePluginInstaller() }
        : { pluginArtifacts: effectiveDeps.resourcePackagePluginArtifacts }),
    })
    const atomicApply = createPostgresqlResourcePackageAtomicApplyOperations({
      db: effectiveDeps.db,
      box,
    })
    return Object.freeze({
      applyActivity: atomicApply,
      catalog: composePostgresqlResourcePackageCatalog({
        provider,
        execution: createPostgresqlResourcePackageExecutionAdapter({
          box,
          provider,
          atomicApply,
        }),
      }),
      commandContextFor(actor: Actor): CommandContext {
        const context = identityAccess.contexts.fromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actor),
          'http',
        )
        packageActorsByAuthority.set(context.authority, actor)
        return context
      },
    })
  })()
  // RFC-359 —— Intent apply 两个 provider 共用**同一台**引擎与同一份装配。此处此前是
  // SQLite 专属的那条线（legacy 资源会话 + SQLite 工件生命周期），与 PostgreSQL 根的
  // `createIntentApplyEngine` 并行存在；判据长期只喂其中一侧。
  const intentApply = composeIntentApplyOperations({
    db: effectiveDeps.db,
    appHome,
    ...effectiveDeps.intentArtifacts,
    aclIdentities: providerResourceCatalog.persistence.identities,
    // RFC-358 §7（AC-6）—— 提交期的图校验。draft 期那道门挡的是模型；这道挡的是
    // draft 与 apply 之间的漂移（别人改了被引用 agent 的端口、上线前的存量草稿）。
    graphValidation: composeIntentWorkflowGraphValidation({
      validationQueries: workflowCatalog.validationQueries,
      workflowQueries: workflowCatalog.queries,
      authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
    }),
  })
  const identityUserOperations = composeIdentityUserOperations({
    identityAccess,
    auth: effectiveDeps.authRuntime,
    afterDisabled: async () => userRuntimeTests.reconcileDurableIntents(),
  })
  const apiComposition = composeSqliteApiRouteMounts(
    effectiveDeps,
    identityAccess,
    identityUserOperations,
    systemOperations,
    userRuntimeTests,
    agentCatalog,
    mcpCatalog,
    mcpProbeStore,
    pluginCatalog,
    skillCatalog,
    workflowCatalog,
    workgroupCatalog,
    resourcePackageBinding,
    providerResourceCatalog,
    memoryCatalog,
    agentResourceIntegrity,
    intentApply,
    taskExecutionPersistence,
    applicationConfiguration,
    configuration,
    unstarted,
  )
  const application = freezeComposedAppDeps({
    token: effectiveDeps.token,
    executionAuthority: effectiveDeps.executionAuthority,
    configuration,
    authentication:
      deps.providerCore?.httpAuthentication ??
      composeLocalHttpAuthentication({
        auth: authRuntime,
        daemonToken: effectiveDeps.token,
        identityAccess,
      }),
    core:
      effectiveDeps.providerCore === undefined
        ? Object.freeze({
            provider: 'sqlite',
            authRuntime,
            tokenCallAudit,
            identityAccess,
            // Compatibility `createApp` has no migration admission to consult.
            sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
          })
        : Object.freeze({ ...effectiveDeps.providerCore, identityAccess }),
    publicRoutes: Object.freeze({
      health: (app: Hono) =>
        mountHealthRoutes(app, effectiveDeps, identityAccess.diagnostics, healthDatabase),
      wellKnown: (app: Hono) => mountWellKnownRoutes(app, { configuration }),
      webhookIngress: (app: Hono) =>
        mountWebhookIngressRoutes(app, composeWebhookIngressTransport(effectiveDeps)),
    }),
    apiRoutes: apiComposition.apiRoutes,
  })
  return Object.freeze({
    ...application,
    taskExecutionModules,
    digitalEmployeeWorkStart: apiComposition.digitalEmployeeWorkStart,
    repositoryWorkspaceStore: repositoryBootstrap.repositoryWorkspaceStore,
    taskExecutionReadModels: effectiveDeps.taskExecutionReadModels,
    collaborationContext: effectiveDeps.collaborationContext,
    resourcePackageApplyActivity:
      resourcePackageBinding?.applyActivity ?? NO_RESOURCE_PACKAGE_APPLY_ACTIVITY,
    intentApplyActivity: Object.freeze({
      activeJournalIds: () => intentApply.activeJournalIds(),
    }),
  })
}

export function composeDigitalEmployeeRoutePersistence(input: {
  readonly identityAccess: IdentityAccessRuntime
  readonly resourceCatalog: ProviderResourceCatalogComposition
  readonly acl: {
    getResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
    ): Promise<ResourceAcl>
    updateResourceAcl(
      actor: Actor,
      type: DigitalEmployeeAclResourceType,
      row: {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'private' | 'public'
      },
      body: UpdateResourceAclBody,
      options?: Parameters<typeof updateResourceAcl>[5],
    ): Promise<ResourceAcl>
  }
}): DigitalEmployeeRoutePersistence {
  async function assertActiveMembers(subject: {
    readonly ownerUserId?: string
    readonly members?: readonly { readonly userId: string }[]
  }): Promise<void> {
    const referenced = new Set((subject.members ?? []).map((member) => member.userId))
    if (subject.ownerUserId !== undefined) referenced.add(subject.ownerUserId)
    if (referenced.size === 0) return
    const people = await input.identityAccess.userDirectory.lookup([...referenced])
    const active = new Set(
      people.filter((person) => person.status === 'active').map((person) => person.id),
    )
    const invalid = [...referenced].filter(
      (userId) => userId === SYSTEM_USER_ID || !active.has(userId),
    )
    if (invalid.length === 0) return
    throw new ValidationError('members-user-invalid', 'referenced user(s) not active', {
      userIds: invalid,
    })
  }

  async function getCaseMembers(
    actor: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[0],
    runtime: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[1],
    row: Parameters<DigitalEmployeeRoutePersistence['getCaseMembers']>[2],
  ): ReturnType<DigitalEmployeeRoutePersistence['getCaseMembers']> {
    const memberRows = await runtime.queries.listCaseMembers(row.id)
    const wanted = [
      ...new Set([
        ...(row.ownerUserId === null ? [] : [row.ownerUserId]),
        ...memberRows.map((member) => member.userId),
      ]),
    ]
    const people =
      wanted.length === 0 ? [] : await input.identityAccess.userDirectory.lookup(wanted)
    const byId = new Map(people.map((person) => [person.id, person]))
    const owner =
      row.ownerUserId === null || row.ownerUserId === SYSTEM_USER_ID
        ? null
        : (byId.get(row.ownerUserId) ?? null)
    const members = memberRows.flatMap((member) => {
      const user = byId.get(member.userId)
      return user === undefined ? [] : [{ user, role: member.role }]
    })
    const canManage = canManageCaseMembers(actor, row)
    return {
      caseId: row.id,
      ownerUserId: row.ownerUserId,
      owner,
      members,
      canManage,
      canOperate:
        canManage ||
        memberRows.some(
          (member) => member.role === 'collaborator' && member.userId === actor.user.id,
        ),
    }
  }

  return Object.freeze({
    assertNameUnchangedForEditor,
    adapterVisibilitySubject(actor: Actor) {
      return { userId: actor.user.id, authority: resourceAclAudienceAuthority(actor) }
    },
    projectVisibleRowsWithAccess: (actor, type, rows) =>
      input.resourceCatalog.authorization.projectVisibleRowsWithAccess(actor, type, rows),
    filterVisibleRows: (actor, type, rows) =>
      input.resourceCatalog.authorization.filterVisibleRows(actor, type, rows),
    requireResourceEdit: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceEdit(actor, type, row),
    requireResourceGovern: (actor, type, row) =>
      input.resourceCatalog.authorization.requireResourceGovern(actor, type, row),
    getCaseMembers,
    async updateCaseMembers(actor, runtime, row, body) {
      if (!canManageCaseMembers(actor, row)) {
        throw new ForbiddenError(
          'forbidden',
          'only the employee case owner or an actor with resource-acl:bypass can manage members',
        )
      }
      await assertActiveMembers(body)
      const current = await runtime.queries.listCaseMembers(row.id)
      const plan = planMembersReplacement({
        prevOwner: row.ownerUserId,
        requestedOwner: body.ownerUserId,
        requestedMembers: body.members,
        currentMembers: current,
      })
      const committed = await runtime.commands.replaceCaseMembers({
        caseId: row.id,
        ownerUserId: plan.nextOwner,
        members: [...plan.nextMembers].map(([userId, role]) => ({ userId, role })),
        addedBy: actor.user.id,
        now: Date.now(),
      })
      const visibleUserIds = new Set<string>()
      if (committed.previousOwnerUserId !== null) {
        visibleUserIds.add(committed.previousOwnerUserId)
      }
      if (plan.nextOwner !== null) visibleUserIds.add(plan.nextOwner)
      for (const userId of committed.previousMemberUserIds) visibleUserIds.add(userId)
      for (const userId of plan.nextMembers.keys()) visibleUserIds.add(userId)
      tasksListBroadcaster.broadcast(
        TASKS_LIST_CHANNEL,
        { type: 'employee-case.members.changed', caseId: row.id },
        { kind: 'employee-case.members-changed-audience', caseId: row.id, visibleUserIds },
      )
      return await getCaseMembers(actor, runtime, { ...row, ownerUserId: plan.nextOwner })
    },
    assertMembersUsersActive: assertActiveMembers,
    mountAcl({ app, type, base, load, notFoundCode }) {
      mountAclEndpoints(app, {
        type,
        base,
        param: 'id',
        load,
        canView: (actor, row) =>
          input.resourceCatalog.authorization.canViewResource(actor, type, row),
        read: (actor, row) => input.acl.getResourceAcl(actor, type, row),
        update: (actor, row, body, updatedAt) =>
          input.acl.updateResourceAcl(actor, type, row, body, {
            ...(updatedAt === undefined ? {} : { updatedAt }),
          }),
        ...(notFoundCode === undefined ? {} : { notFoundCode }),
      })
    },
  } satisfies DigitalEmployeeRoutePersistence)
}

interface SqliteApiRouteComposition {
  readonly apiRoutes: AppApiRouteMounts
  readonly digitalEmployeeWorkStart: DigitalEmployeeWorkStartPort
}

/** SQLite compatibility composition used by direct `createApp({ db })` tests. */
/**
 * RFC-359 —— 资源包路由要的两件事：目录本身，以及**把 authority 认回请求者**的上下文工厂。
 * 它们必须同源——apply 会话在 `create()` 里用 `authorityResolver` 把 `context.authority`
 * 解回 Actor 并与传入的 Actor 对照，路由若另起一条造 context 的路，那次对照就认不出来。
 */
interface ResourcePackageRouteBinding {
  readonly catalog: ComposedResourcePackageCatalog
  readonly applyActivity: ResourcePackageApplyActivityQuery
  commandContextFor(actor: Actor): CommandContext
}

/** 没有 secretBox 就没有 apply 引擎，也就不可能有在执行的 apply。 */
const NO_RESOURCE_PACKAGE_APPLY_ACTIVITY: ResourcePackageApplyActivityQuery = Object.freeze({
  activeApplyIds: () => [],
})

function composeSqliteApiRouteMounts(
  deps: SqliteComposedAppDeps,
  identityAccess: IdentityAccessModule & IntegrationTriggerIdentityAccess,
  identityUserOperations: IdentityUserOperations,
  systemOperations: SystemOperationsModule,
  mcpRuntimeTests: McpDiagnosticsRuntime,
  agentCatalog: AgentCatalogModule,
  mcpCatalog: McpCatalogModule,
  mcpProbeStore: ReturnType<typeof composeMcpProbeStore>,
  pluginCatalog: PluginCatalogModule,
  skillCatalog: SkillCatalogModule,
  workflowCatalog: WorkflowCatalogModule,
  workgroupCatalog: WorkgroupCatalogModule,
  resourcePackageBinding: ResourcePackageRouteBinding | null,
  providerResourceCatalog: ReturnType<typeof composeResourceCatalogFor>,
  composedMemoryCatalog: ReturnType<typeof composeMemoryCatalogOperations>,
  agentResourceIntegrity: AgentResourceIntegrityComposition,
  intentApply: IntentApplyOperations,
  taskExecutionPersistence: ReturnType<typeof createTaskExecutionPersistence>,
  applicationConfiguration: ApplicationConfigurationBinding,
  configuration: ApplicationConfigurationQueries,
  unstarted?: UnstartedApplicationScope,
): SqliteApiRouteComposition {
  const appHome = deps.appHome ?? Paths.root
  const inputArtifacts =
    deps.employeeInputArtifacts ??
    createEmployeeInputArtifactStore(join(appHome, 'artifacts', 'employee-inputs'))
  const developmentDelivery = buildDevelopmentDeliveryDeps(
    deps.developmentDeliveryProvider,
    deps.developmentPurposeRoot.pipeline.staging,
  )
  const repositoryTransportModule = deps.repositoryTransport
  const repositoryWorkspaceStore = deps.repositoryWorkspaceStore
  // RFC-370 §10 V17: SQLite is standalone only, so its mirrors are local clones.
  const repositoryMirrors = composeRepositoryMirrors({
    store: repositoryWorkspaceStore,
    ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
    ...(deps.appHome === undefined ? {} : { appHome: deps.appHome }),
  })
  const codeHostConnections = deps.codeHostConnections
  const repositoryPublicationTransport = deps.repositoryPublicationTransport
  const schedulerDriver = deps.schedulerDriver
  const codeWorkspace = composeLegacyCodeReadProviders(deps.db).workspace
  const { narrativeSystemAgentBinding, runtimeManagement } = deps.observationModules
  const taskRouteOperations = deps.taskExecutionModules.routes.tasks
  const routeDeps = {
    ...deps,
    configuration,
    identityAccess,
    repositoryPublicationTransport,
    schedulerDriver,
    operations: taskRouteOperations,
    workspaceQueries: composeTaskWorkspaceQueries({
      load: taskRouteOperations.get,
      contentScope: (workspaceRef) =>
        createWorkspaceContentScope(workspaceRef, deps.workspaceContent),
    }),
    taskExecutionReadModels: deps.taskExecutionReadModels,
    runtimeInventoryContent: composeTaskRuntimeInventoryContent(deps.runtimeInventoryContent),
    taskRecoveryOperations: taskExecutionPersistence.recoveryAdministration,
    codeWorkspace,
    // RFC-370 §10 V16: the SQLite root is standalone — native worktrees, appHome artifacts.
    codeReview: {
      content: composeLocalRepositoryRevisionContent(),
      artifacts: composeLocalCodeReviewArtifacts(),
    },
    repositoryWorkspace: repositoryWorkspaceStore,
    changeNarrative: {
      async requireMember(actor: Actor, taskId: string) {
        const access = await resolveCollaborationTaskAccess(deps.collaborationContext, {
          actor,
          taskId,
        })
        if (access.task === null) {
          throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        }
        if (access.actorRole === null) {
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
        deps.runtimeRegistry
          .resolveRuntimeByName(runtimeName ?? defaultRuntime)
          .then(narrativeSystemAgentBinding.bindRuntime),
      systemAgents: narrativeSystemAgentBinding.family,
    },
    collaborationContext: deps.collaborationContext,
  }
  const approvalGateway = deps.integrationModules.developmentApprovalGateway
  const developmentWorkspace = composeDevelopmentEmployeeWorkspace({
    automationWorkspaceEffects: deps.automationWorkspaceEffects,
    db: deps.db,
    appHome,
    reactionRounds: createEmployeeReactionRoundQueries(deps.db),
    inputArtifacts,
    repositoryPreparation: deps.repositoryCredentials.developmentWorkspaceRepositoryPreparation,
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
      effects: deps.employeeCaseWorkspaceEffects,
    }),
    conflictMerge: bindConflictMergeParticipant({ effects: deps.conflictMergeWorkspaceEffects }),
  })
  const executionContracts = deps.executionContracts
  const eventCenter = deps.integrationModules.eventCenter
  const digitalEmployeeAgentTemplates =
    deps.digitalEmployeeAgentTemplates ?? deps.resourceCatalogModules.digitalEmployeeAgentTemplates
  const digitalEmployee = composeDigitalEmployee({
    db: deps.db,
    appHome,
    programArtifacts: deps.employeePrograms,
    typePackages: [developmentEmployeeTypePackage],
    typePackageDriftPolicy: deps.digitalEmployeeTypePackageDriftPolicy,
    ...(deps.digitalEmployeePlatformTools === undefined
      ? {}
      : { platformTools: deps.digitalEmployeePlatformTools }),
    executionContracts,
    retryLimits: {
      async current() {
        const config = await configuration.read()
        return {
          defaultNodeRetries: config.defaultNodeRetries,
          sessionRestartBudget: config.sessionRestartBudget,
        }
      },
    },
    inputArtifacts,
    connectionCatalog: deps.integrationModules.developmentToolConnections,
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      detailProjectionParticipants:
        deps.digitalEmployeeCaseDetailProjection === undefined
          ? []
          : [deps.digitalEmployeeCaseDetailProjection],
      // RFC-368 T17 —— Reaction 执行走 `ReactionExecutionPortV1` + 同事务 admission 参与者。
      reactionExecution: composeReactionExecutionProvider({
        db: deps.db,
        // RFC-359 AC-1（plan §5hl）：数字员工执行合成一份——端口 + 启动内核，
        // 与 PostgreSQL daemon 同一条路。此前这一侧在 composer 函数体里直接读库、
        // 用 `startTask` + `preCreatedWorktree` 启动（按定义只服务 SQLite）。
        appHome,
        ...(deps.employeePrograms === undefined
          ? {}
          : { programs: createArtifactProgramToolSource(deps.employeePrograms) }),
        resolveActor: async () => {
          const identity = await admitDaemonIdentity(identityAccess)
          if (identity === null) throw new Error('digital-employee-host-identity-not-admitted')
          return actorOfDirectAuthority(identity)
        },
        resourceAuthorityFor: (actor) => ({
          actor,
          authority: identityAccess.directAuthority.authorityForLegacyProjection(actor),
          resources: identityAccess.taskExecutionResources,
        }),
        launch: deps.taskExecutionModules.routeLaunch.workflow,
        ...composeDatabaseDigitalEmployeeExecutionPorts(deps.db),
        tasks: taskRouteOperations,
        readModels: deps.taskExecutionReadModels,
        agents: {
          get: async (id) => {
            const identity = await admitDaemonIdentity(identityAccess)
            if (identity === null)
              throw new Error('digital-employee-catalog-authority-not-admitted')
            return agentCatalog.queries.get(identity.actor, { id })
          },
        },
        workflows: {
          get: async (id) => {
            const identity = await admitDaemonIdentity(identityAccess)
            if (identity === null)
              throw new Error('digital-employee-catalog-authority-not-admitted')
            return workflowCatalog.queries.get(identity.actor, { id })
          },
        },
        workspace: developmentWorkspace,
        executionContracts,
      }),
      platformWorkItems: composeDevelopmentEmployeePlatformWorkItems({
        automationWorkspaceEffects: deps.automationWorkspaceEffects,
        repositoryBaselines: deps.repositoryBaselines,
        evidenceArtifacts: deps.evidenceArtifacts,
        reactionRounds: createEmployeeReactionRoundQueries(deps.db),
        db: deps.db,
        appHome,
        approvalGateway,
        ...developmentDelivery,
        conflictMerge: bindConflictMergeParticipant({
          effects: deps.conflictMergeWorkspaceEffects,
        }),
        sourceControl: {
          ...bindChangeCandidateParticipant({ candidateEffects: deps.repositoryCandidateEffects }),
          ...bindCandidateDeliveryParticipant({
            candidateEffects: deps.repositoryCandidateEffects,
            publicationTransport: repositoryPublicationTransport,
          }),
          ...bindEmployeeCaseWorkspaceParticipant({
            publicationTransport: repositoryPublicationTransport,
            effects: deps.employeeCaseWorkspaceEffects,
          }),
        },
      }),
    },
  })
  void unstarted?.trackReady(digitalEmployee.maintenance.ready())
  const digitalEmployeeWorkStart = Object.freeze<DigitalEmployeeWorkStartPort>({
    async launch(input) {
      const result = await digitalEmployee.runtime.commands.launchWork({
        employeeId: input.employeeId,
        intake: input.intake,
        actorUserId: input.actorUserId,
        eventOrigin: input.origin,
      })
      return { caseId: result.caseRef.id }
    },
  })
  const taskCatalog = composeTaskCatalog({
    sources: [
      // RFC-357：owner 身份是 identity-access 的能力，由装配根注入；
      // task-execution 只声明端口，不去 compose 别的 context 的 provider。
      ...deps.taskExecutionModules.catalogSources,
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })
  // RFC-359 W11：worker 是必填实参，就地装配。此前是 `composeSqliteAppDeps` 先造一个空槽
  // `operations`、经 deps 传过来，再在这个函数里补一句 `.bind(digitalEmployee.runtime.worker)`
  // ——绕一圈只为把「已经能被调用但还没装配」的窗口拉长跨两个函数。
  const developmentActivityOperations = composeDevelopmentActivityOperations(
    digitalEmployee.runtime.worker,
  )
  const developmentConfigOperations = deps.developmentConfigOperations
  const developmentMissionOperations = deps.developmentMissionOperations
  const databaseMigration = deps.databaseMigration
  const oidcProviders = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })
  const oidcIdentities = composeOidcIdentityOperations({
    db: deps.db,
    identityAccess,
  })
  const memoryCatalog = deps.memoryOperations.catalog ?? composedMemoryCatalog
  const taskRouteLaunch = deps.taskRouteLaunch ?? deps.taskExecutionModules.routeLaunch
  const workgroupTaskRoom = composeWorkgroupTaskRoom({
    db: deps.db,
    taskParticipantFactory: deps.taskExecutionModules.workgroupTaskRoom,
    activeUsers: composeWorkgroupTaskRoomActiveUsers({
      userDirectory: identityAccess.userDirectory,
    }),
    dynamicWorkflow: composeWorkgroupTaskRoomDynamicWorkflow({
      validationContext: deps.taskExecutionModules.validationContext,
      workflows: workflowCatalog.operations.create,
    }),
    systemUserId: SYSTEM_USER_ID,
    continuation: deps.taskExecutionModules.roomContinuation,
    broadcast(taskId, event) {
      taskBroadcaster.broadcast(TASK_CHANNEL(taskId), { id: -1, ...event })
    },
  })
  const { scheduledTaskRuntime } = deps.scheduledTaskModules
  // RFC-359 W57 —— `/api/overview` 两个 provider 共用这一份装配（PG 侧见
  // `cli/postgresqlDaemonApplication.ts`）。此前 SQLite 走
  // `platform/persistence/sqlite/systemOverviewReadModel.ts::buildOverview`、PG 走这一条，
  // 两份实现逐个聚合键语义等价（对账见 RFC-359 plan §5i），是纯重复；`buildOverview`
  // 连同它的私有 in-flight 合流已整份删除。
  //
  // 它装在这一层而不是 `composeSqliteApplicationDeps`，是因为 `integration` 这一路要的是
  // `scheduledTaskRuntime.overview`，而那个 runtime 就在上面几行才装配得起来——依赖在哪层
  // 齐备就在哪层装，不留后填的槽（RFC-359 plan §5g：组合根占位的正解是词法作用域）。
  const overviewQuery: OverviewRouteQuery = composeSystemOverviewQuery({
    resourceCatalog: composeResourceCatalogOverviewQuery(deps.db),
    repositories: deps.repositoryWorkspaceOperations.overviewQueries,
    integration: scheduledTaskRuntime.overview,
    memories: memoryCatalog,
    tasks: deps.taskExecutionModules.overview,
  })
  const scheduledIdentityAccess = Object.freeze({
    ...identityAccess,
    integrationTriggerResources: scheduledTaskRuntime.integrationTriggerResources,
  })
  // RFC-359 AC-1（plan §5hn 批次二 ①②）：定时 / webhook 触发与路由启动**共用同一台内核**。
  // 此前这里是 `services/scheduleLaunch.ts#buildScheduleLaunch`——`startExecution` 那个
  // 三分支 switch 的**第三份**写法（provider runtime 的后台 tick 是第二份）。
  const scheduledLaunch =
    deps.buildScheduleLaunch ?? deps.taskExecutionModules.trigger.buildScheduleLaunch
  const { webhookEndpointService, webhookTriggerService, webhookDeliveryRuntime } =
    deps.integrationModules
  const capabilityTemplateRouteDeps = Object.freeze({
    codeHistoryQueries: deps.codeHistoryQueries,
    capabilityTemplates: deps.resourceCatalogModules.capabilityTemplateOperations,
    capabilityTemplateAcl: deps.resourceCatalogModules.capabilityTemplateAcl,
  } satisfies CapabilityTemplateRouteDeps)
  const intentAuthorityFor = (actor: Actor) =>
    directOperationAuthority(identityAccess.directAuthority, actor)
  const intentCatalogActors = new WeakMap<object, Actor>()
  const intentResourceCatalogFor = composeIntentResourceCatalogFor({
    query: providerResourceCatalog.createQuery({
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
      agents: agentCatalog.queries,
      skills: skillCatalog.queries,
      skillFiles: skillCatalog.fileQueries,
      mcps: mcpCatalog.queries,
      plugins: pluginCatalog.queries,
      workflows: workflowCatalog.queries,
      workgroups: workgroupCatalog.queries,
    },
  })
  const intentPersistence = composeIntentPersistence({
    db: deps.db,
    contextAuthorization: composeIntentContextResourceAuthorizationFactory(),
  })
  const intentPlatformInventory = composeIntentPlatformInventoryParticipant({
    authorityFor: intentAuthorityFor,
    capabilityTemplates: capabilityTemplateRouteDeps.capabilityTemplates,
    developmentConfig: developmentConfigOperations,
    digitalEmployee: composeDigitalEmployeePlatformInventoryParticipant({
      queries: digitalEmployee.queries,
      access: providerResourceCatalog.authorization,
    }),
  })
  const intentDumpAuxiliaryBase = composeIntentDumpAuxiliaryQueries({
    persistence: intentPersistence,
    platformInventory: intentPlatformInventory,
  })
  const intentDumpAuxiliary = Object.freeze({
    ...intentDumpAuxiliaryBase,
    runtimeInventory: Object.freeze({
      ...intentDumpAuxiliaryBase.runtimeInventory,
      async resolveDefault() {
        const runtime = await intentPersistence.resolveIntentRuntime(
          (await configuration.read()).defaultRuntime ?? 'opencode',
        )
        return { name: runtime.name, protocol: runtime.protocol }
      },
    }),
  })
  const intentSystemAgentBinding = deps.observationModules.intentHttpSystemAgentBinding
  const intentSessionRouteInputs: IntentSessionRouteDependencies = {
    appHome,
    configuration,
    events: createIntentSessionWsPublisher(),
    identityAccess,
    directAuthority: identityAccess.directAuthority,
    intentApply,
    intentPersistence,
    intentTurnRuntime: Object.freeze({
      runtimeResolver: composeIntentTurnRuntimeResolver(
        intentPersistence,
        intentSystemAgentBinding.bindRuntime,
      ),
      systemAgents: intentSystemAgentBinding.family,
      dumpAuxiliary: intentDumpAuxiliary,
      // RFC-358: 图校验由 resource-catalog 提供，经它的 exact public 合同注入意图链路。
      graphValidation: composeIntentWorkflowGraphValidation({
        validationQueries: workflowCatalog.validationQueries,
        workflowQueries: workflowCatalog.queries,
        authorityFor: intentAuthorityFor,
      }),
    }),
    resourceCatalogFor: intentResourceCatalogFor,
  }
  const intentSessionRoutes = Object.freeze({
    ...intentSessionRouteInputs,
    ...(deps.intentTestDependencies?.runFn === undefined
      ? {}
      : {
          intentTurnRuntime: Object.freeze({
            ...intentSessionRouteInputs.intentTurnRuntime,
            systemAgents: intentSystemAgentBinding.withFixture(deps.intentTestDependencies.runFn)
              .family,
          }),
        }),
  } satisfies IntentSessionRouteDependencies)
  // RFC-359 W4-D6c：employee_* 的 ACL 走目录的中立 foreign-owner 路径（与 development_adapter 同一条），
  // identity 行由 digital-employee 在目录写事务里交出。
  const digitalEmployeeAclFor = (type: DigitalEmployeeAclResourceType) =>
    deps.resourceCatalogModules.digitalEmployeeAcl[type]
  const digitalEmployeePersistence = composeDigitalEmployeeRoutePersistence({
    identityAccess,
    resourceCatalog: providerResourceCatalog,
    acl: Object.freeze({
      getResourceAcl: (actor, type, row) =>
        digitalEmployeeAclFor(type).getResourceAcl(actor, type, row),
      updateResourceAcl: (actor, type, row, body, options) =>
        digitalEmployeeAclFor(type).updateResourceAcl(actor, type, row, body, {
          ...(options?.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
        }),
    }),
  })
  const missionInputUploads = composeMissionInputUploadOperations({
    db: deps.db,
    appHome,
    blobs: deps.missionInputBlobs,
    artifacts: deps.evidenceArtifacts,
  })
  const collaborationRouteOperations = composeCollaborationRouteOperations({
    followupGenerator: composeClarifyFollowupGenerator({
      db: deps.db,
      registry: deps.runtimeRegistry,
      binding: narrativeSystemAgentBinding,
    }),
    db: deps.db,
    context: deps.collaborationContext,
  })
  const collaborationTaskAccess = createSqliteCollaborationTaskAccessPort(deps.db)
  const taskClarifyDirectiveRoutes = Object.freeze({
    operations: deps.taskExecutionModules.routes.clarifyDirective,
  })
  const worktreeFiles = Object.freeze({
    store: repositoryWorkspaceStore,
    canViewTask: async (actor, task) =>
      (await collaborationTaskAccess.resolveTask(actor, task.id)).visible,
    // RFC-370 §10 V15: the same content the task workspace queries read.
    content: (workspaceRef) =>
      deps.workspaceContent?.bind(workspaceRef) ?? createFileWorkspaceContentEffects(workspaceRef),
  } satisfies WorktreeFilesRouteDeps)
  const { fusionOperations, launchConfiguration: fusionLaunchConfiguration } = deps.fusionModules
  const apiRoutes = Object.freeze({
    config: (app) =>
      mountConfigRoutes(app, {
        configuration: applicationConfiguration.composeCommands({
          runtimeRegistry:
            runtimeManagement.configuration satisfies RuntimeProfileConfigurationCommands,
          withRuntimeProbeConfigFence: composeRuntimeProbeConfigFence(
            applicationConfiguration.notificationKey,
          ),
          runtimeTests: mcpRuntimeTests.reconciliation,
          concurrencyHotApply: deps.configConcurrencyHotApply,
        }),
      }),
    observability: (app) =>
      composeRunObservation({
        db: deps.db,
        tasks: createTaskObservationFacts(deps.db),
        runtimes: runtimeManagement.observations,
      }).mount(app),
    maintenance: (app) =>
      mountMaintenanceRoutes(app, {
        configuration,
        maintenanceStatus: deps.maintenanceStatus,
        databaseTelemetry: deps.databaseTelemetry,
      }),
    daemon: (app) =>
      mountDaemonRoutes(app, {
        runtime: selectDaemonRuntimeQueries(deps.daemonRuntime, { infoPath: deps.daemonInfoPath }),
      }),
    plantuml: (app) => mountPlantumlRoutes(app, { configuration }),
    runtime: (app) => mountRuntimeRoutes(app, runtimeManagement.models),
    runtimes: (app) => mountRuntimesRoutes(app, runtimeManagement.runtimes),
    overview: (app) =>
      mountOverviewRoutes(
        app,
        {
          directAuthority: identityAccess.directAuthority,
        },
        overviewQuery,
      ),
    agents: (app) =>
      mountAgentRoutes(app, {
        queries: agentCatalog.queries,
        referenceQueries: agentCatalog.referenceQueries,
        dependencyQueries: agentCatalog.dependencyQueries,
        resourceIntegrityQueries: agentCatalog.resourceIntegrityQueries,
        importQueries: agentCatalog.importQueries,
        operations: agentCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        listDigitalEmployeeTemplates: () =>
          listDigitalEmployeeAgentTemplates(digitalEmployeeAgentTemplates),
        taskLaunch: taskRouteLaunch.agent,
      }),
    mcps: (app) =>
      mountMcpRoutes(app, {
        queries: mcpCatalog.queries,
        operations: mcpCatalog.operations,
        aclIdentity: mcpCatalog.participants.aclIdentity,
        probeStore: mcpProbeStore,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        runtimeTests: { commands: mcpRuntimeTests.commands, queries: mcpRuntimeTests.queries },
        runtimeTestCommandContextFor: mcpRuntimeTests.contexts.command,
        runtimeTestQueryContextFor: mcpRuntimeTests.contexts.query,
      }),
    plugins: (app) =>
      mountPluginRoutes(app, {
        queries: pluginCatalog.queries,
        operations: pluginCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    skills: (app) =>
      mountSkillRoutes(app, {
        fileCommands: skillCatalog.fileCommands,
        versionCommands: skillCatalog.versionCommands,
        queries: skillCatalog.queries,
        fileQueries: skillCatalog.fileQueries,
        versionQueries: skillCatalog.versionQueries,
        operations: skillCatalog.operations,
        zipImport: skillCatalog.zipImport,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    repos: (app) => mountRepoRoutes(app, repositoryWorkspaceStore, repositoryMirrors),
    cachedRepos: (app) =>
      mountCachedRepoRoutes(
        app,
        { configuration, appHome: deps.appHome, secretBox: deps.secretBox },
        repositoryWorkspaceStore,
        repositoryMirrors,
      ),
    repoGroups: (app) =>
      mountRepoGroupRoutes(app, { configuration }, repositoryWorkspaceStore, repositoryMirrors),
    workflows: (app) =>
      mountWorkflowRoutes(app, deps, {
        queries: workflowCatalog.queries,
        validationQueries: workflowCatalog.validationQueries,
        operations: workflowCatalog.operations,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    workgroups: (app) =>
      mountWorkgroupRoutes(app, {
        queries: workgroupCatalog.queries,
        operations: workgroupCatalog.operations,
        resourceIntegrityQueries: agentResourceIntegrity.queries,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        taskLaunch: taskRouteLaunch.workgroup,
      }),
    resourcePackages: (app) => {
      if (resourcePackageBinding === null) return
      registerResourcePackageRoutes(app, {
        catalog: resourcePackageBinding.catalog,
        commandContextFor: resourcePackageBinding.commandContextFor,
        queryContextFor: (actor) =>
          identityAccess.contexts.queryFromAuthority(
            directRequestAuthority(identityAccess.directAuthority, actor),
            'http',
          ),
      })
    },
    workgroupTasks: (app) =>
      mountWorkgroupTaskRoutes(app, {
        module: workgroupTaskRoom,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
      }),
    tasks: (app) => mountTaskRoutes(app, routeDeps),
    taskCatalog: (app) => mountTaskCatalogRoutes(app, taskCatalog),
    taskArchive: (app) =>
      mountTaskArchiveRoutes(app, {
        configuration,
        taskArchiveMaintenance:
          deps.taskArchiveMaintenance ??
          createDrizzleTaskArchiveMaintenanceCommand(deps.db, deps.taskArchive),
      }),
    maintenanceDisk: (app) => mountMaintenanceDiskRoutes(app, deps.maintenanceDisk),
    scheduledTasks: (app) =>
      mountScheduledTaskRoutes(app, {
        identityAccess: scheduledIdentityAccess,
        scheduledTaskRuntime,
        buildScheduleLaunch: scheduledLaunch,
        getDefaultRuntime: async () => (await configuration.read()).defaultRuntime ?? null,
      }),
    webhookEndpoints: (app) => {
      if (webhookEndpointService === null) return
      mountWebhookEndpointRoutes(app, { webhookEndpointService })
    },
    codeHosts: (app) => mountCodeHostRoutes(app, deps, codeHostConnections),
    repositoryTransportCredentials: (app) => {
      if (repositoryTransportModule === null) return
      mountAccountRepositoryTransportCredentialRoutes(app, deps, {
        credentials: repositoryTransportModule.ownCredentials,
        currentSubjects: identityAccess.resolveAuthority,
      })
    },
    code: (app) => mountCodeRoutes(app, deps.codeHistoryQueries),
    capabilityTemplates: (app) => mountCapabilityTemplateRoutes(app, capabilityTemplateRouteDeps),
    eventCenter: (app) => mountEventCenterRoutes(app, eventCenter),
    executionContracts: (app) => mountExecutionContractRoutes(app, executionContracts),
    digitalEmployees: (app) =>
      mountDigitalEmployeeRoutes(
        app,
        digitalEmployeePersistence,
        digitalEmployee,
        developmentActivityOperations,
        identityAccess.directAuthority,
      ),
    developmentConfig: (app) =>
      mountDevelopmentConfigRoutes(
        app,
        deps.resourceCatalogModules.developmentAclRoutes,
        developmentConfigOperations,
        identityAccess.directAuthority,
      ),
    developmentMissions: (app) =>
      mountDevelopmentMissionRoutes(
        app,
        developmentMissionOperations,
        identityAccess.directAuthority,
      ),
    missionInputUploads: (app) => mountMissionInputUploadRoutes(app, missionInputUploads),
    webhookTriggers: (app) =>
      mountWebhookTriggerRoutes(app, { webhookTriggerService }, scheduledIdentityAccess),
    webhookDeliveries: (app) =>
      mountWebhookDeliveryRoutes(app, {
        webhookDeliveryRuntime,
        ...(deps.digitalEmployeeEventCenter === undefined
          ? {}
          : { digitalEmployeeEventCenter: deps.digitalEmployeeEventCenter }),
        ...(deps.webhookDispatcher === undefined
          ? {}
          : { webhookDispatcher: deps.webhookDispatcher }),
        ...(deps.webhookTerminalControl === undefined
          ? {}
          : { webhookTerminalControl: deps.webhookTerminalControl }),
      }),
    backup: (app) => mountBackupRoutes(app, systemOperations, identityAccess),
    restore: (app) => mountRestoreRoutes(app, systemOperations, identityAccess),
    ...(databaseMigration === undefined
      ? {}
      : {
          databaseMigration: (app: Hono) =>
            mountDatabaseMigrationRoutes(app, databaseMigration.operations, identityAccess),
        }),
    worktreeFiles: (app) => mountWorktreeFilesRoutes(app, worktreeFiles),
    portArtifacts: (app) => mountPortArtifactRoutes(app, deps),
    reviews: (app) => mountReviewRoutes(app, collaborationRouteOperations, appHome),
    clarify: (app) => mountClarifyRoutes(app, collaborationRouteOperations),
    taskQuestions: (app) => mountTaskQuestionRoutes(app, collaborationRouteOperations),
    taskClarifyDirective: (app) => mountTaskClarifyDirectiveRoutes(app, taskClarifyDirectiveRoutes),
    fusion: (app) =>
      mountFusionRoutes(app, {
        operations: fusionOperations,
        launchConfiguration: fusionLaunchConfiguration,
        configPath: deps.configPath,
        directAuthority: identityAccess.directAuthority,
      }),
    // RFC-353 T9：技能来源追溯——版本流水来自 resource-catalog，融合记录来自 memory，
    // 拼装归 knowledge-evolution，所以路由挂在 KE 的 inbound 上。
    skillProvenance: (app) =>
      mountSkillProvenanceRoutes(app, {
        skills: skillCatalog.queries,
        versions: skillCatalog.versionQueries,
        authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
        memoryAuthorityFor: (actor) => ({
          actor,
          authority: directRequestAuthority(identityAccess.directAuthority, actor),
        }),
        listFusedInto: (skillId) => memoryCatalog.queries.listFusedInto(skillId),
        filterVisibleMemories: (authority, rows) =>
          memoryCatalog.queries.filterVisible(authority, rows),
      }),
    intentSessions: (app) => mountIntentSessionRoutes(app, intentSessionRoutes),
    memories: (app) =>
      mountMemoryRoutes(app, memoryCatalog, {
        contexts: identityAccess.contexts,
        directAuthority: identityAccess.directAuthority,
      }),
    memoryDistillJobs: (app) => mountMemoryDistillJobRoutes(app, routeDeps),
    taskFeedback: (app) => mountTaskFeedbackRoutes(app, deps),
    auth: (app) =>
      mountAuthRoutes(app, { configuration }, identityAccess, {
        auth: deps.authRuntime,
        listIdentitiesForUser: (userId) => oidcIdentities.listIdentitiesForUser(userId),
        listTokenAuditForUser: (userId) => deps.tokenCallAudit.listForUser(userId),
      }),
    oidcAuth: (app) =>
      mountOidcAuthRoutes(
        app,
        { configuration },
        {
          auth: deps.authRuntime,
          providers: oidcProviders,
          identities: oidcIdentities,
        },
      ),
    oidc: (app) => mountOidcRoutes(app, { auth: deps.authRuntime, providers: oidcProviders }),
    users: (app) =>
      mountUserRoutes(
        app,
        { auth: deps.authRuntime, listTokenAudit: () => deps.tokenCallAudit.list() },
        {
          contexts: identityAccess.contexts,
          directAuthority: identityAccess.directAuthority,
          operations: identityUserOperations,
        },
      ),
    docs: (app) => mountDocsRoutes(app, { configuration }),
  } satisfies AppApiRouteMounts)
  return Object.freeze({
    apiRoutes,
    digitalEmployeeWorkStart,
  })
}

/**
 * Every `/api/*` route in its canonical order.  Provider composition supplies
 * closed bindings, but cannot add, remove or reorder route domains.
 */
export function mountApiRoutes(app: Hono, deps: ComposedAppDeps): void {
  const authority = deps.executionAuthority
  if (authority !== undefined) bindExecutionAvailability(app, () => executionStatusOf(authority))
  const routes = deps.apiRoutes
  routes.observability(app)
  routes.config(app)
  routes.maintenance(app)
  routes.daemon(app)
  routes.plantuml(app)
  routes.runtime(app)
  routes.runtimes(app)
  routes.overview(app)
  routes.agents(app)
  routes.mcps(app)
  routes.plugins(app)
  routes.skills(app)
  routes.repos(app)
  routes.cachedRepos(app)
  routes.repoGroups(app)
  routes.workflows(app)
  routes.workgroups(app)
  routes.resourcePackages(app)
  routes.workgroupTasks(app)
  // `taskArchive` 必须挂在 `tasks` **之前**，这不是审美问题：`routes/tasks.ts` 给任务子资源装了
  // 一道可见性中间件 `'/api/tasks/:id/*'`，而 **Hono 的 `*` 能匹配零个段**——它会命中兄弟字面
  // 路由 `POST /api/tasks/archive` 并把 `id` 解成 `'archive'`，然后去查一个叫 archive 的任务、
  // 查不到就 404，路由自己的 `settings:write` 门永远轮不到执行。而 Hono 的中间件与处理器按注册
  // 顺序组链，先注册的终结处理器会在中间件之前收口：archive 先挂，中间件对它一次都不跑，对
  // `/api/tasks/:id` 与 `/api/tasks/:id/...` 则照旧生效。
  //
  // 症状只在**非管理员**身上出现（`assertTaskVisibleProjection` 第一句对 `tasks:read:all` 短路），
  // 所以管理员一路 200、e2e 的 OPS-038 却连红十三晚（Expected 403 / Received 404）。判据在
  // `tests/rfc311-task-archive-route-reachability.test.ts`——它钉的是结果（非管理员打到的是自己的
  // 权限门，不是 404），次序写错就红。**再往 `/api/tasks/` 下加字面路由时，一律挂在 tasks 之前。**
  routes.taskArchive(app)
  routes.tasks(app)
  routes.taskCatalog(app)
  routes.maintenanceDisk(app)
  routes.scheduledTasks(app)
  routes.webhookEndpoints(app)
  routes.codeHosts(app)
  routes.repositoryTransportCredentials(app)
  routes.code(app)
  routes.capabilityTemplates(app)
  routes.eventCenter(app)
  routes.executionContracts(app)
  routes.digitalEmployees(app)
  routes.developmentConfig(app)
  routes.developmentMissions(app)
  routes.missionInputUploads(app)
  routes.webhookTriggers(app)
  routes.webhookDeliveries(app)
  routes.backup(app)
  routes.restore(app)
  routes.databaseMigration?.(app)
  for (const alias of SYSTEM_OPERATION_ALIASES) registerOperationAlias(alias)
  routes.worktreeFiles(app)
  routes.portArtifacts(app)
  routes.reviews(app)
  routes.clarify(app)
  routes.taskQuestions(app)
  routes.taskClarifyDirective(app)
  routes.fusion(app)
  routes.intentSessions(app)
  routes.memories(app)
  routes.memoryDistillJobs(app)
  routes.taskFeedback(app)
  routes.auth(app)
  routes.oidcAuth(app)
  routes.oidc(app)
  routes.users(app)
  routes.docs(app)
}

/** Shared request transport; callers supply already-composed route bindings. */
export interface HttpRequestAppDeps {
  readonly authentication: HttpAuthenticationParticipant
  readonly core: ComposedAppDeps['core']
  readonly publicRoutes: ComposedAppDeps['publicRoutes']
  readonly mountApi: AppRouteMount
  /** RFC-370 M0 — states the deployment to the embedded SPA; standalone by default. */
  readonly deploymentMode?: FrontendDeploymentMode
}

export function createHttpRequestApp(deps: HttpRequestAppDeps): Hono {
  const log = createLogger('http')
  const app = new Hono()

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    log.debug('req', { method: c.req.method, path: c.req.path, status: c.res.status, ms })
  })

  deps.publicRoutes.health(app)
  deps.publicRoutes.wellKnown(app)
  deps.publicRoutes.webhookIngress(app)
  deps.publicRoutes.crewStationEvents?.(app)

  app.use('/api/*', composeHttpAuthenticationMiddleware(deps.authentication))
  app.use('/api/*', async (c, next) => {
    await next()
    const actor = tryActorOf(c)
    if (actor === null || actor.source !== 'pat' || c.req.path === '/api/mcp') return
    // RFC-349 T10: the migration-control path stays reachable while the source
    // is frozen, so this projection would be the request path's other writer.
    if (!deps.core.sourceWriteWindow.writable()) return
    void deps.core.tokenCallAudit.record({
      actor,
      channel: 'rest',
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      deletedSnapshot: takeDeleteSnapshot(c),
    })
  })

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/whoami',
      permissions: [],
      publicReason:
        'identity self-introspection; any authenticated actor may ask who it is, and a token needs it because RFC-247 D6 closes /api/auth/me to tokens',
      tokenAccess: 'allow',
      summary: 'Resolved actor identity for the current credential',
    },
    (c) => {
      const actor = actorOf(c)
      return c.json({
        ok: true,
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        user: {
          id: actor.user.id,
          username: actor.user.username,
          displayName: actor.user.displayName,
          role: actor.user.role,
          status: actor.user.status,
        },
        source: actor.source,
      })
    },
  )

  deps.mountApi(app)
  app.onError(errorHandler)

  if (IS_EMBEDDED) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
        return c.json(
          { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
          404,
        )
      }
      const response = await getEmbeddedFrontendResponse(
        c.req.path,
        undefined,
        deps.deploymentMode ?? 'standalone',
      )
      if (response !== null) return response
      return c.json(
        { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
        404,
      )
    })
  }

  app.notFound((c) =>
    c.json({ ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` }, 404),
  )
  return app
}

/** Build the HTTP/MCP application from already-selected provider ports. */
export function createComposedApp(deps: ComposedAppDeps): Hono {
  return createHttpRequestApp({
    authentication: deps.authentication,
    core: deps.core,
    publicRoutes: deps.publicRoutes,
    deploymentMode: deps.executionAuthority?.mode ?? 'standalone',
    mountApi(app) {
      mountApiRoutes(app, deps)
      mountMcpTransport(app, {
        tokenCallAudit: deps.core.tokenCallAudit,
        configuration: deps.configuration,
        operationInvokerFor: (actor) =>
          createBoundOperationInvoker(
            app,
            directMcpOperationAuthority(deps.core.identityAccess.directAuthority, actor),
          ),
      })

      assertRouteMetaCoverage(
        app.routes.map((route) => ({ method: route.method, path: route.path })),
      )
      assertOperationCatalogClosed()
    },
  })
}

export function createApp(deps: AppDeps): Hono
export function createApp(deps: ComposedAppDeps): Hono
export function createApp(deps: AppDeps | ComposedAppDeps): Hono {
  return createComposedApp('apiRoutes' in deps ? deps : composeSqliteAppDeps(deps))
}

export interface RequirementPurposeSelection extends RequirementAdapterBinding {
  readonly staging: EvidenceStagingFactory
  readonly documentCommands: EvidenceDocumentCommands
}
export interface PipelinePurposeSelection extends PipelineAdapterBinding {
  readonly staging: PipelineStagingFactories
}
export interface DevelopmentPurposeSelection {
  readonly requirement?: RequirementPurposeSelection
  readonly pipeline?: PipelinePurposeSelection
  readonly approval?: ApprovalAdapterBinding
}
export interface SelectedDevelopmentPurposeRoot {
  readonly requirement: RequirementPurposeSelection
  readonly pipeline: PipelinePurposeSelection
  readonly approval: ApprovalAdapterBinding
  readonly evidenceArtifacts: EvidenceArtifactPort
}

function assertPurposePair(
  selection: RequirementPurposeSelection | PipelinePurposeSelection | ApprovalAdapterBinding,
  names: readonly string[],
  factories: readonly EvidenceStagingFactory[],
): void {
  if (typeof selection?.configurationFor !== 'function') {
    throw new Error('development-purpose-configuration-binding-incomplete')
  }
  const effects = selection.effects
  if (
    typeof effects?.programs?.bind !== 'function' ||
    effects.namespace?.kind !== 'evidence-staging-namespace'
  ) {
    throw new Error('development-purpose-program-binding-incomplete')
  }
  const members = effects as unknown as Record<string, unknown>
  for (const name of names) {
    if (typeof members[name] !== 'function') {
      throw new Error(`development-purpose-effects-incomplete:${name}`)
    }
  }
  for (const factory of factories) {
    assertEvidenceStagingFactory(factory)
    if (factory.namespace.reference !== effects.namespace?.reference) {
      throw new Error('development-purpose-staging-namespace-mismatch')
    }
  }
}

/** Bootstrap selects each whole purpose pair once and forwards it to every subcomposition. */
export function composeDevelopmentPurposeRoot(input: {
  readonly appHome: string
  readonly selection?: DevelopmentPurposeSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
}): SelectedDevelopmentPurposeRoot {
  let evidence = input.evidenceArtifacts
  const artifacts = (): EvidenceArtifactPort =>
    (evidence ??= createLocalEvidenceArtifactPort(input.appHome))
  const content = createLocalEvidenceStagingNamespace(artifacts)
  const native = createLocalDevelopmentAdapterEffects({
    namespace: content.namespace,
    resolveStaging: (reference) => content.resolve(reference),
  })
  const nativeBinding = (mockKey: string) => {
    const secretSource = Object.freeze({ ...process.env })
    const mockUrl = process.env[mockKey]
    return {
      configurationFor(content: Parameters<RequirementAdapterBinding['configurationFor']>[0]) {
        return native.configurationFor({
          adapterContent: content,
          secretSource,
          ...(mockUrl === undefined ? {} : { extraEnv: { [mockKey]: mockUrl } }),
        })
      },
    }
  }
  const requirement = input.selection?.requirement ?? {
    ...nativeBinding('AW_REQUIREMENT_MOCK_URL'),
    effects: native.requirement,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'requirement',
      root: join(input.appHome, 'evidence', 'staging'),
    }),
    get documentCommands() {
      return (
        input.evidenceDocumentCommands ??
        createFileEvidenceDocumentCommands({
          evidence: artifacts(),
          stagingRoot: join(input.appHome, 'evidence', 'staging'),
        })
      )
    },
  }
  const pipeline = input.selection?.pipeline ?? {
    ...nativeBinding('AW_PIPELINE_MOCK_URL'),
    effects: native.pipeline,
    staging: {
      collect: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-sink-',
      }),
      trigger: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-trigger-',
      }),
      rerun: createLocalEvidenceStagingFactory(content, {
        kind: 'temporary',
        prefix: 'aw-pipeline-rerun-',
      }),
    },
  }
  const approval = input.selection?.approval ?? {
    ...nativeBinding('AW_APPROVAL_MOCK_URL'),
    effects: native.approval,
    staging: createLocalEvidenceStagingFactory(content, {
      kind: 'temporary',
      prefix: 'aw-approval-adapter-',
    }),
  }
  assertPurposePair(
    requirement,
    ['acquire', 'questionsWriteback', 'answersCollect'],
    [requirement.staging],
  )
  // The selected writer is checked without evaluating the default native writer early.
  if (
    input.selection?.requirement !== undefined &&
    typeof requirement.documentCommands?.writeDocument !== 'function'
  ) {
    throw new Error('development-purpose-document-commands-incomplete')
  }
  assertPurposePair(
    pipeline,
    ['collect', 'trigger', 'rerun'],
    [pipeline.staging.collect, pipeline.staging.trigger, pipeline.staging.rerun],
  )
  assertPurposePair(approval, ['submit', 'lookup', 'observe'], [approval.staging])
  return {
    requirement,
    pipeline,
    approval,
    get evidenceArtifacts() {
      return artifacts()
    },
  }
}
